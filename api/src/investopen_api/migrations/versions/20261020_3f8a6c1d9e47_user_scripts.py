"""user scripts

Revision ID: 3f8a6c1d9e47
Revises: 7c3e91d4a8b2
Create Date: 2026-10-20 10:05:12.482913

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3f8a6c1d9e47"
down_revision: str | Sequence[str] | None = "7c3e91d4a8b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "user_scripts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=True),
        sa.Column("api_version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("user_scripts")
