"""Golden cases for the volume group (Phase 12, batch B5): src/builtins/groups/volume.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.
"""

from __future__ import annotations

from golden_common import Case, Cases


def cases() -> list[Case]:
    out = Cases()
    return out.items
