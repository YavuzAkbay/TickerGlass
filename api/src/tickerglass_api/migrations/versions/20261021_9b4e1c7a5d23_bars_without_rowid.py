"""bars without rowid

SQLite only: store `bars` clustered on its primary key (WITHOUT ROWID). The table has a
four-column text/int key and no other index, so the separate rowid b-tree plus the key
index of an ordinary table are redundant; this is about 40% smaller. A no-op elsewhere.

Revision ID: 9b4e1c7a5d23
Revises: d73d9998ea0e
Create Date: 2026-10-21 17:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9b4e1c7a5d23"
down_revision: str | Sequence[str] | None = "d73d9998ea0e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = "symbol, interval, prepost, ts, open, high, low, close, adj_close, volume"


def _rebuild_bars(*, with_rowid: bool) -> None:
    # Left behind by a run that crashed mid-copy (SQLite DDL here is not transactional).
    op.execute("DROP TABLE IF EXISTS bars_new")
    op.create_table(
        "bars_new",
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("interval", sa.String(length=8), nullable=False),
        sa.Column("prepost", sa.Boolean(), nullable=False),
        sa.Column("ts", sa.BigInteger(), nullable=False),
        sa.Column("open", sa.Float(), nullable=False),
        sa.Column("high", sa.Float(), nullable=False),
        sa.Column("low", sa.Float(), nullable=False),
        sa.Column("close", sa.Float(), nullable=False),
        sa.Column("adj_close", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("symbol", "interval", "prepost", "ts"),
        sqlite_with_rowid=with_rowid,
    )
    # Key order makes the copy a sequential append. `bars` has no index besides its key.
    op.execute(
        f"INSERT INTO bars_new ({COLUMNS}) SELECT {COLUMNS} FROM bars "
        "ORDER BY symbol, interval, prepost, ts"
    )
    op.drop_table("bars")
    op.rename_table("bars_new", "bars")


def upgrade() -> None:
    """Upgrade schema."""
    if op.get_bind().dialect.name != "sqlite":
        return
    _rebuild_bars(with_rowid=False)


def downgrade() -> None:
    """Downgrade schema."""
    if op.get_bind().dialect.name != "sqlite":
        return
    _rebuild_bars(with_rowid=True)
