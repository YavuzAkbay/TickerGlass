"""series refresh schedule

Revision ID: d73d9998ea0e
Revises: 3f8a6c1d9e47
Create Date: 2026-10-21 09:40:31.215604

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d73d9998ea0e"
down_revision: str | Sequence[str] | None = "3f8a6c1d9e47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("series_meta") as batch_op:
        batch_op.add_column(sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("quiet_streak", sa.Integer(), server_default="0", nullable=False)
        )
        batch_op.add_column(
            sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True)
        )
    # Existing series count as used when they were backfilled.
    op.execute("UPDATE series_meta SET last_accessed_at = backfilled_at")


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("series_meta") as batch_op:
        batch_op.drop_column("last_accessed_at")
        batch_op.drop_column("quiet_streak")
        batch_op.drop_column("next_check_at")
