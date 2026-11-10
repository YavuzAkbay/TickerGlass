"""server-side screener: universe, snapshots, fundamentals, runs, leases, saved screens

Revision ID: c4a1e8d27b90
Revises: 5d2a7f3c9e18
Create Date: 2026-11-06 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4a1e8d27b90"
down_revision: str | Sequence[str] | None = "5d2a7f3c9e18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Nullable Float columns of `screener_snapshots`, in model order.
_SNAPSHOT_FLOATS = (
    "last",
    "prev_close",
    "chg1d_pct",
    "gap_pct",
    "volume",
    "avg_vol30",
    "rel_vol",
    "avg_dollar_vol30",
    "perf_1w",
    "perf_1m",
    "perf_3m",
    "perf_6m",
    "perf_ytd",
    "perf_1y",
    "rsi14",
    "prev_rsi14",
    "sma20",
    "sma50",
    "sma200",
    "prev_last",
    "prev_sma20",
    "prev_sma50",
    "prev_sma200",
    "pct_vs_sma20",
    "pct_vs_sma50",
    "pct_vs_sma200",
    "hi52",
    "lo52",
    "pct_off_hi52",
    "pct_off_lo52",
)


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "screener_symbols",
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("cls", sa.String(length=12), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("grp", sa.String(length=64), nullable=False),
        sa.Column("exchange", sa.String(length=32), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("cap_static", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=8), nullable=False),
        sa.Column("fail_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.String(length=200), nullable=True),
        sa.Column("tombstoned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("symbol"),
    )
    with op.batch_alter_table("screener_symbols", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_screener_symbols_cls"), ["cls"], unique=False)

    op.create_table(
        "screener_lists",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("as_of", sa.String(length=10), nullable=False),
        sa.Column("source", sa.String(length=8), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "screener_list_members",
        sa.Column("list_id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.ForeignKeyConstraint(["list_id"], ["screener_lists.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("list_id", "symbol"),
    )
    with op.batch_alter_table("screener_list_members", schema=None) as batch_op:
        batch_op.create_index("ix_screener_list_members_symbol", ["symbol"], unique=False)

    op.create_table(
        "screener_snapshots",
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("as_of_date", sa.Date(), nullable=False),
        sa.Column("bar_ts", sa.BigInteger(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bars_count", sa.Integer(), nullable=False),
        *(sa.Column(name, sa.Float(), nullable=True) for name in _SNAPSHOT_FLOATS),
        sa.Column("new_hi52", sa.Boolean(), nullable=True),
        sa.Column("new_lo52", sa.Boolean(), nullable=True),
        sa.Column("atr14", sa.Float(), nullable=True),
        sa.Column("atr_pct", sa.Float(), nullable=True),
        sa.Column("cross_state", sa.SmallInteger(), nullable=True),
        sa.Column("days_since_cross", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("symbol"),
    )
    with op.batch_alter_table("screener_snapshots", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_screener_snapshots_as_of_date"), ["as_of_date"], unique=False
        )

    op.create_table(
        "screener_fundamentals",
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("mcap", sa.Float(), nullable=True),
        sa.Column("pe", sa.Float(), nullable=True),
        sa.Column("fwd_pe", sa.Float(), nullable=True),
        sa.Column("eps_ttm", sa.Float(), nullable=True),
        sa.Column("div_yield_pct", sa.Float(), nullable=True),
        sa.Column("beta", sa.Float(), nullable=True),
        sa.Column("shares_out", sa.Float(), nullable=True),
        sa.Column("sector", sa.String(length=64), nullable=True),
        sa.Column("industry", sa.String(length=100), nullable=True),
        sa.Column("next_earnings_ts", sa.BigInteger(), nullable=True),
        sa.Column("quote_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("info_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("symbol"),
    )

    op.create_table(
        "screener_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("trigger", sa.String(length=10), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("done", sa.Integer(), nullable=False),
        sa.Column("failed", sa.Integer(), nullable=False),
        sa.Column("tokens", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("screener_runs", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_screener_runs_started_at"), ["started_at"], unique=False
        )

    op.create_table(
        "job_leases",
        sa.Column("name", sa.String(length=32), nullable=False),
        sa.Column("owner", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )

    op.create_table(
        "screens",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("spec", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("alert", sa.JSON(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "screen_states",
        sa.Column("screen_id", sa.String(length=36), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("members", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["screen_id"], ["screens.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("screen_id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("screen_states")
    op.drop_table("screens")
    op.drop_table("job_leases")
    with op.batch_alter_table("screener_runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_screener_runs_started_at"))
    op.drop_table("screener_runs")
    op.drop_table("screener_fundamentals")
    with op.batch_alter_table("screener_snapshots", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_screener_snapshots_as_of_date"))
    op.drop_table("screener_snapshots")
    with op.batch_alter_table("screener_list_members", schema=None) as batch_op:
        batch_op.drop_index("ix_screener_list_members_symbol")
    op.drop_table("screener_list_members")
    op.drop_table("screener_lists")
    with op.batch_alter_table("screener_symbols", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_screener_symbols_cls"))
    op.drop_table("screener_symbols")
