"""multi-user: users, identities, owner_id on every top-level user-data table

Creates the owner user (role admin, id in app_meta['owner_user_id']) and moves every existing
row under it (docs/design/multi-user.md). `settings` / `symbol_flags` become per-owner keys,
template names unique per owner. `screener_lists.owner_id` is nullable: user-made lists
(source 'upload', kind 'custom') belong to the owner, bundled ones (and overridden bundled
ones) stay shared (NULL).

Revision ID: a91c4d7e2b60
Revises: e7b3c05a9d14
Create Date: 2026-11-12 09:00:00.000000

"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a91c4d7e2b60"
down_revision: str | Sequence[str] | None = "e7b3c05a9d14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OWNER_KEY = "owner_user_id"

#: table -> {unique constraint: its columns before the owner was added}. These get a plain
#: indexed `owner_id`.
PLAIN: dict[str, dict[str, list[str]]] = {
    "layouts": {},
    "drawings": {},
    "indicator_templates": {"uq_indicator_templates_name": ["name"]},
    "drawing_templates": {"uq_drawing_templates_type_name": ["tool_type", "name"]},
    "chart_templates": {"uq_chart_templates_name": ["name"]},
    "notes": {},
    "watchlists": {},
    "user_scripts": {},
    "alerts": {},
    "alert_log": {},
    "screens": {},
    "portfolios": {},
}
#: table -> (its key column, the other columns). The key becomes `(owner_id, key)`.
REKEYED: dict[str, tuple[str, list[str]]] = {
    "settings": ("key", ["value", "updated_at"]),
    "symbol_flags": ("symbol", ["color", "created_at", "updated_at"]),
}


def _fk(table: str) -> str:
    return f"fk_{table}_owner_id_users"


def _sqlite() -> bool:
    return op.get_context().dialect.name == "sqlite"


def _rekeyed_columns(table: str, *, with_owner: bool) -> list[sa.Column[Any]]:
    """The full column list of a re-keyed table (SQLite rebuilds it: batch mode cannot turn a
    reflected single-column key into a composite one without a warning)."""
    cols: list[sa.Column[Any]] = []
    if with_owner:
        cols.append(sa.Column("owner_id", sa.String(length=32), nullable=False))
    if table == "settings":
        cols += [
            sa.Column("key", sa.String(length=64), nullable=False),
            sa.Column("value", sa.JSON(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        ]
    else:
        cols += [
            sa.Column("symbol", sa.String(length=32), nullable=False),
            sa.Column("color", sa.String(length=16), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        ]
    return cols


def _rebuild(table: str, *, with_owner: bool, owner: str | None) -> None:
    """SQLite: copy `table` into a rebuilt one with / without the owner-first key."""
    key, rest = REKEYED[table]
    tmp = f"_new_{table}"
    columns = _rekeyed_columns(table, with_owner=with_owner)
    constraints: list[sa.schema.SchemaItem]
    if with_owner:
        constraints = [
            sa.ForeignKeyConstraint(
                ["owner_id"], ["users.id"], name=_fk(table), ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("owner_id", key, name=f"{table}_pkey"),
        ]
    else:
        constraints = [sa.PrimaryKeyConstraint(key, name=f"{table}_pkey")]
    op.create_table(tmp, *columns, *constraints)
    names = ", ".join([key, *rest])
    if with_owner:
        op.execute(
            sa.text(
                f"INSERT INTO {tmp} (owner_id, {names}) SELECT :owner, {names} FROM {table}"
            ).bindparams(owner=owner)
        )
    else:
        op.execute(sa.text(f"INSERT INTO {tmp} ({names}) SELECT {names} FROM {table}"))
    op.drop_table(table)
    op.rename_table(tmp, table)


def upgrade() -> None:
    """Upgrade schema."""
    owner = uuid.uuid4().hex
    now = datetime.now(UTC)

    op.create_table(
        "users",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("role", sa.String(length=8), server_default="user", nullable=False),
        sa.Column("disabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "user_identities",
        sa.Column("key", sa.String(length=300), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("key"),
    )
    with op.batch_alter_table("user_identities", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_user_identities_user_id"), ["user_id"], unique=False)

    users = sa.table(
        "users",
        sa.column("id", sa.String),
        sa.column("name", sa.String),
        sa.column("role", sa.String),
        sa.column("disabled", sa.Boolean),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(
        users,
        [{"id": owner, "name": "Owner", "role": "admin", "disabled": False, "created_at": now}],
    )
    meta = sa.table(
        "app_meta",
        sa.column("key", sa.String),
        sa.column("value", sa.JSON),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(meta, [{"key": OWNER_KEY, "value": owner, "updated_at": now}])

    def add_owner_column(table: str) -> None:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column("owner_id", sa.String(length=32), nullable=True))
        # Every existing row moves under the owner; the column then turns NOT NULL without a
        # default, so nothing can insert an ownerless row afterwards.
        tbl = sa.table(table, sa.column("owner_id", sa.String))
        op.execute(tbl.update().values(owner_id=owner))

    for table, uniques in PLAIN.items():
        add_owner_column(table)
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column("owner_id", existing_type=sa.String(length=32), nullable=False)
            batch_op.create_foreign_key(
                _fk(table), "users", ["owner_id"], ["id"], ondelete="CASCADE"
            )
            batch_op.create_index(batch_op.f(f"ix_{table}_owner_id"), ["owner_id"])
            for name, columns in uniques.items():
                batch_op.drop_constraint(name, type_="unique")
                batch_op.create_unique_constraint(name, ["owner_id", *columns])

    for table, (key, _rest) in REKEYED.items():
        if _sqlite():
            _rebuild(table, with_owner=True, owner=owner)
            continue
        add_owner_column(table)
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column("owner_id", existing_type=sa.String(length=32), nullable=False)
            batch_op.create_foreign_key(
                _fk(table), "users", ["owner_id"], ["id"], ondelete="CASCADE"
            )
            batch_op.drop_constraint(f"{table}_pkey", type_="primary")
            batch_op.create_primary_key(f"{table}_pkey", ["owner_id", key])

    with op.batch_alter_table("screener_lists", schema=None) as batch_op:
        batch_op.add_column(sa.Column("owner_id", sa.String(length=32), nullable=True))
        batch_op.create_foreign_key(
            _fk("screener_lists"), "users", ["owner_id"], ["id"], ondelete="CASCADE"
        )
        batch_op.create_index(batch_op.f("ix_screener_lists_owner_id"), ["owner_id"])
    lists = sa.table(
        "screener_lists",
        sa.column("owner_id", sa.String),
        sa.column("source", sa.String),
        sa.column("kind", sa.String),
    )
    op.execute(
        lists.update()
        .where(lists.c.source == "upload", lists.c.kind == "custom")
        .values(owner_id=owner)
    )


def downgrade() -> None:
    """Downgrade schema.

    The single-user schema cannot hold other users' data, so this refuses to run while more
    than the owner user exists (delete them first) instead of silently dropping their rows."""
    bind = op.get_bind()
    if (bind.scalar(sa.text("SELECT count(*) FROM users")) or 0) > 1:
        raise RuntimeError(
            "refusing to downgrade: other users exist and the single-user schema would "
            "drop or merge their data; delete those users first"
        )
    with op.batch_alter_table("screener_lists", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_screener_lists_owner_id"))
        batch_op.drop_constraint(_fk("screener_lists"), type_="foreignkey")
        batch_op.drop_column("owner_id")

    for table, (key, _rest) in REKEYED.items():
        if _sqlite():
            _rebuild(table, with_owner=False, owner=None)
            continue
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_constraint(f"{table}_pkey", type_="primary")
            batch_op.drop_constraint(_fk(table), type_="foreignkey")
            batch_op.drop_column("owner_id")
            batch_op.create_primary_key(f"{table}_pkey", [key])

    for table, uniques in reversed(PLAIN.items()):
        with op.batch_alter_table(table, schema=None) as batch_op:
            for name, columns in uniques.items():
                batch_op.drop_constraint(name, type_="unique")
                batch_op.create_unique_constraint(name, columns)
            batch_op.drop_index(batch_op.f(f"ix_{table}_owner_id"))
            batch_op.drop_constraint(_fk(table), type_="foreignkey")
            batch_op.drop_column("owner_id")

    meta = sa.table("app_meta", sa.column("key", sa.String))
    op.execute(meta.delete().where(meta.c.key == OWNER_KEY))
    with op.batch_alter_table("user_identities", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_user_identities_user_id"))
    op.drop_table("user_identities")
    op.drop_table("users")
