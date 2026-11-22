"""Row ownership for multi-user (docs/design/multi-user.md, "Enforcement").

Every top-level user-data model carries an `owner_id`. A session is either

- *owner-scoped*: `session.info["owner_id"]` is a user id. Every ORM SELECT / UPDATE / DELETE on
  an owned model gets `with_loader_criteria(Model, Model.owner_id == owner)` (shared models, i.e.
  `screener_lists`, also show their `owner_id IS NULL` rows to SELECTs), new owned rows get the
  owner filled in, and writing a row of another owner raises; or
- *system*: `session.info["all_owners"] = True` (the alerts-service routes, the screener, the
  dispatcher, maintenance, migrations). Nothing is added; new rows must name their owner.

A session with neither flag that touches an owned model raises `OwnershipError`: there is no
silent unscoped query. Core statements (`insert(Table)`, `text()` is invisible) on owned tables
are refused in owner-scoped sessions: route code goes through the ORM.

`owned_get` is the explicit second layer: it filters by owner itself, so a bug in the hook is
not a leak (and `Session.get` on an identity-mapped row would skip the criteria).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, TypeVar, cast

from sqlalchemy import ColumnElement, Engine, Table, event, inspect, or_, select
from sqlalchemy.orm import Session, sessionmaker, with_loader_criteria
from sqlalchemy.orm.attributes import get_history
from sqlalchemy.sql.dml import Insert
from sqlalchemy.sql.util import find_tables

if TYPE_CHECKING:
    from sqlalchemy.orm import ORMExecuteState

OWNER_KEY = "owner_id"
ALL_OWNERS_KEY = "all_owners"

T = TypeVar("T")


class OwnershipError(RuntimeError):
    """An owned model was touched without an owner scope, or across owners."""


_owned: tuple[type, ...] = ()
_shared: tuple[type, ...] = ()
_by_table: dict[str, type] = {}
_installed = False


def install(owned: tuple[type, ...], shared: tuple[type, ...] = ()) -> None:
    """Register the hooks on every `Session` (idempotent). Called by `models.py`, so any code
    that can see a model is covered."""
    global _owned, _shared, _by_table, _installed
    _owned, _shared = owned, shared
    _by_table = {cast("Any", cls).__tablename__: cls for cls in owned}
    if _installed:
        return
    _installed = True
    event.listen(Session, "do_orm_execute", _on_execute)
    event.listen(Session, "before_flush", _before_flush)


# ------------------------------------------------------------------ sessions


def session_owner(session: Session) -> str | None:
    """The owner a session is scoped to, None for system / unscoped sessions."""
    owner = session.info.get(OWNER_KEY)
    return owner if isinstance(owner, str) and owner else None


def is_system(session: Session) -> bool:
    return session.info.get(ALL_OWNERS_KEY) is True


def scope_to_owner(session: Session, owner_id: str) -> Session:
    if not owner_id:
        raise OwnershipError("an owner-scoped session needs an owner id")
    session.info[OWNER_KEY] = owner_id
    return session


def scope_to_system(session: Session) -> Session:
    session.info[ALL_OWNERS_KEY] = True
    return session


@contextmanager
def owner_session(maker: sessionmaker[Session], owner_id: str) -> Iterator[Session]:
    """A session limited to one owner's rows."""
    with maker() as session:
        yield scope_to_owner(session, owner_id)


@contextmanager
def system_session(maker: sessionmaker[Session]) -> Iterator[Session]:
    """A session that sees every owner's rows. System code only (never a request of a user)."""
    with maker() as session:
        yield scope_to_system(session)


@contextmanager
def engine_system_session(engine: Engine) -> Iterator[Session]:
    """`system_session` for background jobs that hold an engine, not a sessionmaker."""
    with Session(engine) as session:
        yield scope_to_system(session)


# -------------------------------------------------------------------- get


def owned_get(
    session: Session,
    model: type[T],
    ident: Any,
    *,
    owner_id: str | None = None,
    populate_existing: bool = False,
) -> T | None:
    """The row of `model` with this primary key (the key without `owner_id` for `Setting` /
    `SymbolFlag`) if it belongs to the owner, else None. `owner_id` defaults to the session's;
    a system session without one reads across owners (it is system code by definition)."""
    owner = owner_id or session_owner(session)
    if owner is None and not is_system(session):
        raise OwnershipError("owned_get needs an owner-scoped or system session")
    mapper = cast("Any", inspect(model))
    keys = [c for c in mapper.primary_key if c.key != OWNER_KEY]
    if len(keys) != 1:
        raise TypeError(f"{model.__name__}: owned_get needs a single-column key")
    cls = cast("Any", model)
    stmt = select(cls).where(keys[0] == ident)
    if owner is not None:
        stmt = stmt.where(cls.owner_id == owner)
    if populate_existing:
        stmt = stmt.execution_options(populate_existing=True)
    row = session.execute(stmt).scalar_one_or_none()
    return cast("T | None", row)


def id_taken_by_other(session: Session, model: type, ident: Any) -> bool:
    """True when a row of `model` with this client-chosen key exists but belongs to someone
    else. Used to answer 409 "id in use" (and nothing more) before inserting, instead of an
    IntegrityError. Goes through the connection, below the ORM hooks, on purpose: it must see
    other owners' rows, and it only ever returns a bool."""
    owner = session_owner(session)
    if owner is None:
        raise OwnershipError("id_taken_by_other needs an owner-scoped session")
    mapper = cast("Any", inspect(model))
    if any(c.key == OWNER_KEY for c in mapper.primary_key):
        # (owner_id, key) models: the same key under another owner is not a collision.
        raise TypeError(f"{model.__name__}: keys are per owner; ids cannot collide")
    keys = list(mapper.primary_key)
    if len(keys) != 1:
        raise TypeError(f"{model.__name__}: id_taken_by_other needs a single-column key")
    table = cast("Any", model).__table__
    stmt = select(table.c[OWNER_KEY]).where(table.c[keys[0].key] == ident).limit(1)
    found = session.connection().execute(stmt).scalar_one_or_none()
    return found is not None and found != owner


# ------------------------------------------------------------------- hooks


def _tables(statement: Any) -> set[str]:
    """Names of the tables a statement names anywhere: froms, columns, joins, subqueries, DML
    targets. Plain INSERTs are not walked (their values can be thousands of nodes and cannot
    read a table)."""
    if isinstance(statement, Insert):
        found = {cast("Table", statement.table).name}
        source = statement.select
        if source is not None:
            found |= {
                t.name
                for t in find_tables(source, check_columns=True, include_aliases=True)
                if isinstance(t, Table)
            }
        return found
    if not hasattr(statement, "_from_objects"):
        return set()  # `text()` and DDL are invisible here; route code must not use them
    tables = find_tables(
        statement, check_columns=True, include_aliases=True, include_joins=True, include_crud=True
    )
    return {t.name for t in tables if isinstance(t, Table)}


def _owned_models(statement: Any) -> list[type]:
    names = _tables(statement)
    return [cls for name, cls in _by_table.items() if name in names]


def _criteria(model: type, owner: str, *, select_stmt: bool) -> ColumnElement[bool]:
    column = cast("Any", model).owner_id
    mine: ColumnElement[bool] = column == owner
    if select_stmt and issubclass(model, _shared):
        return or_(mine, column.is_(None))
    return mine


def _on_execute(state: ORMExecuteState) -> None:
    if state.is_column_load:
        return  # refresh of a row this session already holds (it passed the criteria)
    models = _owned_models(state.statement)
    if not models:
        return
    owner = session_owner(state.session)
    if owner is None:
        if is_system(state.session):
            return
        names = ", ".join(sorted(m.__name__ for m in models))
        raise OwnershipError(
            f"query on owned data ({names}) in a session with neither owner_id nor all_owners"
        )
    if not state.is_orm_statement:
        # Table-level statements (`Model.__table__`, `select(exists())`) get no criteria.
        raise OwnershipError(
            "owned tables are reached through ORM select/update/delete/add in owner sessions"
        )
    if state.is_insert:
        # `insert(Model).values(...)`: the owner is forced in (it wins over any given owner_id).
        # Parameter lists / dicts could carry another owner per row: not supported.
        if len(models) != 1 or state.parameters:
            raise OwnershipError("unsupported insert on owned data in an owner-scoped session")
        state.statement = cast("Any", state.statement).values(**{OWNER_KEY: owner})
        return
    if not (state.is_select or state.is_update or state.is_delete):
        raise OwnershipError("unsupported statement on owned data in an owner-scoped session")
    if state.is_relationship_load:
        return  # lazy loads inherit the criteria of the statement that loaded the parent
    options = [
        with_loader_criteria(
            model, _criteria(model, owner, select_stmt=state.is_select), include_aliases=True
        )
        for model in models
    ]
    state.statement = cast("Any", state.statement).options(*options)


def _is_owned(obj: object) -> bool:
    return bool(_owned) and isinstance(obj, _owned)


def _before_flush(session: Session, _ctx: object, _instances: object) -> None:
    owner = session_owner(session)
    system = is_system(session)
    for obj in session.new:
        if not _is_owned(obj):
            continue
        current = cast("Any", obj).owner_id
        if owner is not None:
            if current is None:
                cast("Any", obj).owner_id = owner
            elif current != owner:
                raise OwnershipError(f"{type(obj).__name__}: new row belongs to another owner")
        elif system:
            if current is None and not isinstance(obj, _shared):
                raise OwnershipError(f"{type(obj).__name__}: system writes must name an owner_id")
        else:
            raise OwnershipError(f"{type(obj).__name__}: write in an unscoped session")
    for obj in (*session.dirty, *session.deleted):
        if not _is_owned(obj):
            continue
        if owner is None:
            if system:
                continue
            raise OwnershipError(f"{type(obj).__name__}: write in an unscoped session")
        current = cast("Any", obj).owner_id
        if current != owner:
            raise OwnershipError(f"{type(obj).__name__}: row belongs to another owner")
        if obj in session.dirty and get_history(obj, OWNER_KEY).has_changes():
            raise OwnershipError(f"{type(obj).__name__}: the owner of a row cannot change")


__all__ = [
    "ALL_OWNERS_KEY",
    "OWNER_KEY",
    "OwnershipError",
    "engine_system_session",
    "install",
    "is_system",
    "owned_get",
    "owner_session",
    "scope_to_owner",
    "scope_to_system",
    "session_owner",
    "system_session",
]
