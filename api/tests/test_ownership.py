"""Row ownership (ownership.py) and the multi-user migration: the automatic scoping hooks, the
cross-owner write guard, `owned_get`, and what the migration does to an existing database."""

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Engine, create_engine, delete, exists, func, inspect, select, text, update
from sqlalchemy.orm import Session, sessionmaker
from test_userdata import alembic_config

from tickerglass_api import models as m
from tickerglass_api.db import Base, make_engine
from tickerglass_api.ownership import (
    OwnershipError,
    id_taken_by_other,
    owned_get,
    owner_session,
    scope_to_system,
    system_session,
)

T = datetime(2026, 1, 1, tzinfo=UTC)
PRE_MULTI_USER = "e7b3c05a9d14"


# --------------------------------------------------------------------- hooks


@pytest.fixture
def maker(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    url = f"sqlite:///{tmp_path}/o.db"
    command.upgrade(alembic_config(url), "head")
    engine = make_engine(url)
    with Session(engine) as s, s.begin():
        s.add_all(
            [
                m.User(id="a" * 32, name="A", role="user", disabled=False, created_at=T),
                m.User(id="b" * 32, name="B", role="user", disabled=False, created_at=T),
            ]
        )
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


A, B = "a" * 32, "b" * 32


def watchlist(wid: str, **kw: Any) -> m.Watchlist:
    return m.Watchlist(id=wid, name=wid, items=[], revision=1, created_at=T, updated_at=T, **kw)


def seed(maker: sessionmaker[Session]) -> None:
    with system_session(maker) as s, s.begin():
        s.add_all([watchlist("wa", owner_id=A), watchlist("wb", owner_id=B)])
        s.add_all(
            [
                m.Setting(owner_id=A, key="k", value=1, updated_at=T),
                m.Setting(owner_id=B, key="k", value=2, updated_at=T),
            ]
        )


def test_unscoped_query_raises(maker: sessionmaker[Session]) -> None:
    with maker() as s:
        with pytest.raises(OwnershipError):
            s.execute(select(m.Watchlist)).all()
        with pytest.raises(OwnershipError):
            s.scalar(select(func.count()).select_from(m.Alert))
        with pytest.raises(OwnershipError):
            s.execute(delete(m.Layout))
        with pytest.raises(OwnershipError):
            s.get(m.Note, "x")


def test_unscoped_write_raises(maker: sessionmaker[Session]) -> None:
    with maker() as s:
        s.add(watchlist("w", owner_id=A))
        with pytest.raises(OwnershipError):
            s.flush()


def test_core_statement_on_owned_table_is_refused(maker: sessionmaker[Session]) -> None:
    table = m.Watchlist.__table__
    with maker() as s, pytest.raises(OwnershipError):
        s.execute(select(table))
    with owner_session(maker, A) as s:
        with pytest.raises(OwnershipError):
            s.execute(select(table))
        with pytest.raises(OwnershipError):
            s.execute(delete(table))
        with pytest.raises(OwnershipError):
            s.execute(table.insert().values(id="x"))
    # Not owned: no scope needed.
    with maker() as s:
        assert s.scalar(select(func.count()).select_from(m.Bar)) == 0


def test_select_update_delete_are_scoped(maker: sessionmaker[Session]) -> None:
    seed(maker)
    with owner_session(maker, A) as s:
        assert [w.id for w in s.scalars(select(m.Watchlist))] == ["wa"]
        assert s.scalar(select(func.count()).select_from(m.Watchlist)) == 1
        assert s.scalars(select(m.Watchlist.id).where(m.Watchlist.id == "wb")).all() == []
        # The identity map cannot smuggle a row in either.
        assert s.get(m.Watchlist, "wb") is None and s.get(m.Watchlist, "wa") is not None
        # ORM-enabled bulk UPDATE / DELETE only touch the owner's rows (with_loader_criteria
        # applies to them in the installed SQLAlchemy).
        res = s.execute(
            update(m.Watchlist)
            .values(name="renamed")
            .where(m.Watchlist.id.in_(["wa", "wb"]))
            .execution_options(synchronize_session=False)
        )
        assert res.rowcount == 1  # type: ignore[attr-defined]
        res = s.execute(
            delete(m.Setting)
            .where(m.Setting.key == "k")
            .execution_options(synchronize_session=False)
        )
        assert res.rowcount == 1  # type: ignore[attr-defined]
        s.commit()
    with owner_session(maker, B) as s:
        assert [(w.id, w.name) for w in s.scalars(select(m.Watchlist))] == [("wb", "wb")]
        assert [r.value for r in s.scalars(select(m.Setting))] == [2]
    with system_session(maker) as s:
        assert {w.id for w in s.scalars(select(m.Watchlist))} == {"wa", "wb"}


def test_criteria_reach_subqueries_and_joins(maker: sessionmaker[Session]) -> None:
    seed(maker)
    with owner_session(maker, A) as s:
        ids = select(m.Watchlist.id).where(m.Watchlist.id.in_(select(m.Watchlist.id)))
        assert s.scalars(ids).all() == ["wa"]
        nested = select(m.Watchlist.id).where(exists().where(m.Watchlist.id == "wb"))
        assert s.scalars(nested).all() == []  # the EXISTS only sees A's rows
        # Not ORM-enabled (no entity to attach criteria to): refused, not left unscoped.
        with pytest.raises(OwnershipError):
            s.scalar(select(exists().where(m.Watchlist.id == "wb")))
        joined = select(m.Watchlist.id, m.Setting.key).join(
            m.Setting, m.Setting.owner_id == m.Watchlist.owner_id
        )
        assert s.execute(joined).all() == [("wa", "k")]


def test_new_rows_get_the_owner_and_foreign_owners_raise(maker: sessionmaker[Session]) -> None:
    with owner_session(maker, A) as s:
        row = watchlist("w1")
        s.add(row)
        s.commit()
        assert row.owner_id == A
    with owner_session(maker, A) as s:
        s.add(watchlist("w2", owner_id=B))
        with pytest.raises(OwnershipError):
            s.flush()


def test_the_owner_of_a_row_cannot_change(maker: sessionmaker[Session]) -> None:
    seed(maker)
    with owner_session(maker, A) as s:
        row = s.get(m.Watchlist, "wa")
        assert row is not None
        row.owner_id = B
        with pytest.raises(OwnershipError):
            s.flush()


def test_cross_owner_row_in_the_session_cannot_be_written_or_deleted(
    maker: sessionmaker[Session],
) -> None:
    seed(maker)
    with maker() as s:
        scope_to_system(s)
        foreign = s.get(m.Watchlist, "wb")
        assert foreign is not None
        s.info["owner_id"] = A  # now an owner session holding someone else's row
        foreign.name = "mine now"
        with pytest.raises(OwnershipError):
            s.flush()
        s.rollback()
        s.delete(foreign)
        with pytest.raises(OwnershipError):
            s.flush()


def test_system_sessions_must_name_the_owner(maker: sessionmaker[Session]) -> None:
    with system_session(maker) as s:
        s.add(m.Watchlist(id="w", name="w", items=[], revision=1, created_at=T, updated_at=T))
        with pytest.raises(OwnershipError):
            s.flush()


def test_owned_get_filters_by_owner(maker: sessionmaker[Session]) -> None:
    seed(maker)
    with owner_session(maker, A) as s:
        assert owned_get(s, m.Watchlist, "wa") is not None
        assert owned_get(s, m.Watchlist, "wb") is None
        # Settings are keyed by (owner, key): the key alone is the lookup.
        setting = owned_get(s, m.Setting, "k")
        assert setting is not None and setting.value == 1
        # An explicit owner overrides the session's (and still filters).
        assert owned_get(s, m.Watchlist, "wb", owner_id=A) is None
    with system_session(maker) as s:
        assert owned_get(s, m.Watchlist, "wb") is not None
        assert owned_get(s, m.Watchlist, "wb", owner_id=A) is None
        assert owned_get(s, m.Watchlist, "wb", owner_id=B) is not None
    with maker() as s, pytest.raises(OwnershipError):
        owned_get(s, m.Watchlist, "wa")


def test_id_taken_by_other(maker: sessionmaker[Session]) -> None:
    seed(maker)  # "wa" is A's, "wb" is B's
    with owner_session(maker, A) as s:
        assert id_taken_by_other(s, m.Watchlist, "wb") is True  # someone else's
        assert id_taken_by_other(s, m.Watchlist, "wa") is False  # my own: not "taken by other"
        assert id_taken_by_other(s, m.Watchlist, "free") is False  # nobody's
    with owner_session(maker, B) as s:
        assert id_taken_by_other(s, m.Watchlist, "wa") is True
    # Fail closed: system and unscoped sessions have no "other".
    with system_session(maker) as s, pytest.raises(OwnershipError):
        id_taken_by_other(s, m.Watchlist, "wa")
    with maker() as s, pytest.raises(OwnershipError):
        id_taken_by_other(s, m.Watchlist, "wa")


def test_per_owner_keys_may_collide(maker: sessionmaker[Session]) -> None:
    seed(maker)  # both owners hold setting "k"
    with owner_session(maker, A) as s:
        s.add(m.SymbolFlag(symbol="AAPL", color="red", created_at=T, updated_at=T))
        s.commit()
    with owner_session(maker, B) as s:
        s.add(m.SymbolFlag(symbol="AAPL", color="blue", created_at=T, updated_at=T))
        s.add(
            m.IndicatorTemplate(
                id="t1", name="T", instances=[], schema_version=1, created_at=T, updated_at=T
            )
        )
        s.commit()
    with owner_session(maker, A) as s:
        s.add(
            m.IndicatorTemplate(
                id="t2", name="T", instances=[], schema_version=1, created_at=T, updated_at=T
            )
        )
        s.commit()
        assert [f.color for f in s.scalars(select(m.SymbolFlag))] == ["red"]


def test_shared_screener_lists(maker: sessionmaker[Session]) -> None:
    with system_session(maker) as s, s.begin():
        s.add(
            m.ScreenerList(
                id="idx",
                name="Index",
                kind="index",
                as_of="2026-01",
                source="bundled",
                updated_at=T,
            )
        )
    with owner_session(maker, A) as s:
        s.add(
            m.ScreenerList(
                id="mine",
                name="Mine",
                kind="custom",
                as_of="2026-01",
                source="upload",
                updated_at=T,
            )
        )
        s.commit()
    with owner_session(maker, B) as s:
        assert [x.id for x in s.scalars(select(m.ScreenerList))] == ["idx"]  # shared, not A's
        shared = s.get(m.ScreenerList, "idx")
        assert shared is not None and shared.owner_id is None
        shared.name = "hacked"  # a user cannot write a shared row ...
        with pytest.raises(OwnershipError):
            s.flush()
        s.rollback()
        res = s.execute(delete(m.ScreenerList).execution_options(synchronize_session=False))
        assert res.rowcount == 0  # type: ignore[attr-defined]  # ... bulk ops only reach own rows
    with owner_session(maker, A) as s:
        assert {x.id for x in s.scalars(select(m.ScreenerList))} == {"idx", "mine"}
        mine = s.get(m.ScreenerList, "mine")
        assert mine is not None and mine.owner_id == A


def test_deleting_a_user_cascades_their_data(maker: sessionmaker[Session]) -> None:
    seed(maker)
    with maker() as s, s.begin():
        s.add(m.UserIdentity(key="password:a", user_id=A, created_at=T))
    with maker() as s, s.begin():
        s.delete(s.get(m.User, A))
    with system_session(maker) as s:
        assert [w.id for w in s.scalars(select(m.Watchlist))] == ["wb"]
        assert [r.owner_id for r in s.scalars(select(m.Setting))] == [B]
        assert s.scalar(select(func.count()).select_from(m.UserIdentity)) == 0


# ----------------------------------------------------------------- migration


def _engine(tmp_path: Path) -> tuple[Engine, Any]:
    url = f"sqlite:///{tmp_path}/mig.db"
    return create_engine(url), alembic_config(url)


def test_migration_moves_existing_rows_under_the_owner(tmp_path: Path) -> None:
    engine, cfg = _engine(tmp_path)
    command.upgrade(cfg, PRE_MULTI_USER)
    stamp = "2026-01-01 00:00:00"
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO settings (key, value, updated_at) VALUES ('fav', '[1]', :t)"),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO symbol_flags (symbol, color, created_at, updated_at) "
                "VALUES ('AAPL', 'red', :t, :t)"
            ),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO indicator_templates (id, name, instances, schema_version, "
                "created_at, updated_at) VALUES ('t1', 'T', '[]', 1, :t, :t)"
            ),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO notes (id, text, kind, revision, created_at, updated_at) "
                "VALUES ('n1', 'hi', 'note', 1, :t, :t)"
            ),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO portfolios (id, name, base_currency, cost_method, revision, "
                "created_at, updated_at) VALUES ('p1', 'P', 'USD', 'fifo', 1, :t, :t)"
            ),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO journal_entries (id, portfolio_id, note_id, tags, revision, "
                "created_at, updated_at) VALUES ('j1', 'p1', 'n1', '[]', 1, :t, :t)"
            ),
            {"t": stamp},
        )
        conn.execute(
            text(
                "INSERT INTO screener_lists (id, name, kind, as_of, source, updated_at) VALUES "
                "('mine', 'Mine', 'custom', '2026-01', 'upload', :t), "
                "('sp', 'SP', 'index', '2026-01', 'bundled', :t), "
                "('over', 'Over', 'index', '2026-01', 'upload', :t)"
            ),
            {"t": stamp},
        )

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        users = conn.execute(text("SELECT id, name, role, disabled FROM users")).all()
        assert len(users) == 1 and users[0][1:] == ("Owner", "admin", 0)
        owner = users[0][0]
        meta = conn.execute(text("SELECT value FROM app_meta WHERE key = 'owner_user_id'"))
        assert meta.scalar_one() == f'"{owner}"'
        for table in (
            "settings", "symbol_flags", "indicator_templates", "notes", "portfolios",
        ):  # fmt: skip
            owners = conn.execute(text(f"SELECT DISTINCT owner_id FROM {table}")).scalars().all()
            assert owners == [owner], table
        # Children keep their links (the rebuild of `notes` must not null the journal's note).
        assert conn.execute(text("SELECT note_id FROM journal_entries")).scalar_one() == "n1"
        lists = dict(conn.execute(text("SELECT id, owner_id FROM screener_lists")).all())
        assert lists == {"mine": owner, "sp": None, "over": None}
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
        assert diff == [], diff

    insp = inspect(engine)
    assert insp.get_pk_constraint("settings")["constrained_columns"] == ["owner_id", "key"]
    assert insp.get_pk_constraint("symbol_flags")["constrained_columns"] == ["owner_id", "symbol"]
    unique = {
        t: insp.get_unique_constraints(t) for t in ("indicator_templates", "drawing_templates")
    }
    assert [u["column_names"] for u in unique["indicator_templates"]] == [["owner_id", "name"]]
    assert [u["column_names"] for u in unique["drawing_templates"]] == [
        ["owner_id", "tool_type", "name"]
    ]
    assert insp.get_foreign_keys("notes")[0]["options"]["ondelete"] == "CASCADE"
    owner_col = next(c for c in insp.get_columns("layouts") if c["name"] == "owner_id")
    assert owner_col["nullable"] is False and owner_col["default"] is None
    engine.dispose()


def test_migration_downgrade_and_back(tmp_path: Path) -> None:
    engine, cfg = _engine(tmp_path)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, PRE_MULTI_USER)
    insp = inspect(engine)
    assert "users" not in insp.get_table_names()
    assert insp.get_pk_constraint("settings")["constrained_columns"] == ["key"]
    assert insp.get_pk_constraint("symbol_flags")["constrained_columns"] == ["symbol"]
    assert not any(c["name"] == "owner_id" for c in insp.get_columns("alerts"))
    assert [u["column_names"] for u in insp.get_unique_constraints("chart_templates")] == [["name"]]
    with engine.connect() as conn:
        assert (
            conn.execute(text("SELECT count(*) FROM app_meta WHERE key = 'owner_user_id'")).scalar()
            == 0
        )
    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM users")).scalar() == 1
    engine.dispose()


def test_migration_downgrade_refuses_while_other_users_exist(tmp_path: Path) -> None:
    engine, cfg = _engine(tmp_path)
    command.upgrade(cfg, "head")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, name, role, disabled, created_at) "
                "VALUES ('x', 'X', 'user', 0, '2026-01-01 00:00:00')"
            )
        )
    with pytest.raises(RuntimeError, match="other users exist"):
        command.downgrade(cfg, PRE_MULTI_USER)
    assert "users" in inspect(engine).get_table_names()  # untouched
    engine.dispose()
