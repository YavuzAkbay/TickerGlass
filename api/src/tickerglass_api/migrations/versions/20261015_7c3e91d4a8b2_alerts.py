"""alerts, alert state, log and delivery outbox (Phase 10)

Revision ID: 7c3e91d4a8b2
Revises: 50fc9b162b6f
Create Date: 2026-10-15 09:12:41.318204

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7c3e91d4a8b2"
down_revision: str | Sequence[str] | None = "50fc9b162b6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "alerts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("symbol", sa.String(length=128), nullable=False),
        sa.Column("interval", sa.String(length=16), nullable=False),
        sa.Column("prepost", sa.Boolean(), nullable=False),
        sa.Column("spec", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("notify", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("status_reason", sa.String(length=500), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("drawing_id", sa.String(length=64), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("fire_count", sa.Integer(), nullable=False),
        sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("alerts", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_alerts_drawing_id"), ["drawing_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_alerts_status"), ["status"], unique=False)
        batch_op.create_index(batch_op.f("ix_alerts_symbol"), ["symbol"], unique=False)

    op.create_table(
        "alert_states",
        sa.Column("alert_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("alert_id"),
    )

    op.create_table(
        "alert_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("fire_id", sa.String(length=36), nullable=False),
        sa.Column("alert_id", sa.String(length=36), nullable=True),
        sa.Column("alert_name", sa.String(length=200), nullable=False),
        sa.Column("symbol", sa.String(length=128), nullable=False),
        sa.Column("interval", sa.String(length=16), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bar_time", sa.BigInteger(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("values", sa.JSON(), nullable=False),
        sa.Column("delayed", sa.Boolean(), nullable=False),
        sa.Column("final", sa.Boolean(), nullable=False),
        sa.Column("read", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("fire_id"),
    )
    with op.batch_alter_table("alert_log", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_alert_log_alert_id"), ["alert_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_alert_log_fired_at"), ["fired_at"], unique=False)
        batch_op.create_index(batch_op.f("ix_alert_log_symbol"), ["symbol"], unique=False)

    op.create_table(
        "alert_deliveries",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("log_id", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("target", sa.String(length=500), nullable=True),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(["log_id"], ["alert_log.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("alert_deliveries", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_alert_deliveries_log_id"), ["log_id"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_alert_deliveries_next_attempt_at"), ["next_attempt_at"], unique=False
        )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("alert_deliveries")
    op.drop_table("alert_log")
    op.drop_table("alert_states")
    op.drop_table("alerts")
