"""user data: layouts, drawings, templates, settings, notes (Phase 7)

Revision ID: bd686f7c13d4
Revises: ab134c579451
Create Date: 2026-10-13 18:07:34.243009

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "bd686f7c13d4"
down_revision: str | Sequence[str] | None = "ab134c579451"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column[datetime]]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "layouts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("is_last_used", sa.Boolean(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "drawings",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("pane_id", sa.String(length=64), nullable=False),
        sa.Column("z", sa.Integer(), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_drawings_symbol", "drawings", ["symbol"])
    op.create_table(
        "indicator_templates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("instances", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_indicator_templates_name"),
    )
    op.create_table(
        "drawing_templates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tool_type", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("style", sa.JSON(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tool_type", "name", name="uq_drawing_templates_type_name"),
    )
    op.create_index("ix_drawing_templates_tool_type", "drawing_templates", ["tool_type"])
    op.create_table(
        "chart_templates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_chart_templates_name"),
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "notes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notes_symbol", "notes", ["symbol"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_notes_symbol", table_name="notes")
    op.drop_table("notes")
    op.drop_table("settings")
    op.drop_table("chart_templates")
    op.drop_index("ix_drawing_templates_tool_type", table_name="drawing_templates")
    op.drop_table("drawing_templates")
    op.drop_table("indicator_templates")
    op.drop_index("ix_drawings_symbol", table_name="drawings")
    op.drop_table("drawings")
    op.drop_table("layouts")
