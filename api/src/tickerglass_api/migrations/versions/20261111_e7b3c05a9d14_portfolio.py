"""portfolio: portfolios, transactions, trade journal entries and screenshots, notes.kind

Revision ID: e7b3c05a9d14
Revises: c4a1e8d27b90
Create Date: 2026-11-11 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e7b3c05a9d14"
down_revision: str | Sequence[str] | None = "c4a1e8d27b90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("notes", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("kind", sa.String(length=16), server_default="note", nullable=False)
        )

    op.create_table(
        "portfolios",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("base_currency", sa.String(length=3), nullable=False),
        sa.Column("benchmark", sa.String(length=32), nullable=True),
        sa.Column("cost_method", sa.String(length=8), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "portfolio_transactions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("portfolio_id", sa.String(length=36), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=True),
        sa.Column("price", sa.Float(), nullable=True),
        sa.Column("amount", sa.Float(), nullable=True),
        sa.Column("fee", sa.Float(), server_default="0", nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("note", sa.String(length=2000), nullable=True),
        sa.Column("source", sa.String(length=40), nullable=False),
        sa.Column("external_id", sa.String(length=128), nullable=True),
        sa.Column("import_batch", sa.String(length=36), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["portfolio_id"], ["portfolios.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "portfolio_id", "external_id", name="uq_portfolio_transactions_portfolio_external"
        ),
        sa.UniqueConstraint("portfolio_id", "seq", name="uq_portfolio_transactions_portfolio_seq"),
    )
    with op.batch_alter_table("portfolio_transactions", schema=None) as batch_op:
        batch_op.create_index(
            "ix_portfolio_transactions_portfolio_time_seq",
            ["portfolio_id", "time", "seq"],
            unique=False,
        )

    op.create_table(
        "journal_entries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("portfolio_id", sa.String(length=36), nullable=False),
        sa.Column("transaction_id", sa.String(length=36), nullable=True),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("note_id", sa.String(length=36), nullable=True),
        sa.Column("setup", sa.String(length=80), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("stop", sa.Float(), nullable=True),
        sa.Column("r_multiple", sa.Float(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["portfolio_id"], ["portfolios.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["transaction_id"], ["portfolio_transactions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("journal_entries", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_journal_entries_note_id"), ["note_id"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_journal_entries_portfolio_id"), ["portfolio_id"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_journal_entries_transaction_id"), ["transaction_id"], unique=False
        )

    op.create_table(
        "journal_screenshots",
        sa.Column("entry_id", sa.String(length=36), nullable=False),
        sa.Column("mime", sa.String(length=16), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["entry_id"], ["journal_entries.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("entry_id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("journal_screenshots")
    with op.batch_alter_table("journal_entries", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_journal_entries_transaction_id"))
        batch_op.drop_index(batch_op.f("ix_journal_entries_portfolio_id"))
        batch_op.drop_index(batch_op.f("ix_journal_entries_note_id"))
    op.drop_table("journal_entries")
    with op.batch_alter_table("portfolio_transactions", schema=None) as batch_op:
        batch_op.drop_index("ix_portfolio_transactions_portfolio_time_seq")
    op.drop_table("portfolio_transactions")
    op.drop_table("portfolios")
    with op.batch_alter_table("notes", schema=None) as batch_op:
        batch_op.drop_column("kind")
