"""scheduled backups: backup_runs

Revision ID: b5e2f19c7a31
Revises: a91c4d7e2b60
Create Date: 2026-11-13 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b5e2f19c7a31"
down_revision: str | Sequence[str] | None = "a91c4d7e2b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "backup_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("trigger", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("file_name", sa.String(length=80), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=True),
        sa.Column("results", sa.JSON(), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("backup_runs", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_backup_runs_started_at"), ["started_at"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("backup_runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_backup_runs_started_at"))
    op.drop_table("backup_runs")
