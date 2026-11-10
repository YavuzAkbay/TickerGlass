"""One-time converter: the web app's TS universe datasets -> the API's JSON bundle.

    uv run python scripts/convert_screener_universe.py [web_universe_dir] [out_dir]

Reads `apps/web/src/screener/universe/{stocks,etfs,crypto,commodities}.ts` and writes
`src/tickerglass_api/screener_data/<cls>.json` as `{"asOf", "rows": [[symbol, name, group,
exchange|null, cap|null], ...]}` in row (= rank) order. Caps stay in USD billions. The index
lists in `screener_data/lists/` are curated by hand and not touched. The TS datasets are
deleted (the JSON bundle is the source of truth now); this script is historical and only runs
when a copy of them is supplied as `web_universe_dir`.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

CLASSES = ("stocks", "etfs", "crypto", "commodities")
AS_OF = "2026-01"

_ROW = re.compile(r"^\s*\[(.*)\],?\s*$")
_TOKEN = re.compile(
    r"""\s*(?:
        (?P<str>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")
      | (?P<num>-?\d+(?:\.\d+)?)
      | (?P<undef>undefined)
    )\s*(?:,|$)""",
    re.VERBOSE,
)


def parse_row(body: str) -> list[Any]:
    """The cells of one `[...]` row body (strings, numbers, `undefined`)."""
    cells: list[Any] = []
    pos = 0
    while pos < len(body):
        m = _TOKEN.match(body, pos)
        if not m or m.end() == pos:
            raise ValueError(f"cannot parse row: {body!r}")
        if m["str"] is not None:
            raw = m["str"][1:-1]
            cells.append(re.sub(r"\\(.)", r"\1", raw))
        elif m["num"] is not None:
            n = float(m["num"])
            cells.append(int(n) if n == int(n) else n)
        else:
            cells.append(None)
        pos = m.end()
    return cells


def parse_ts(text: str) -> list[list[Any]]:
    rows: list[list[Any]] = []
    in_rows = False
    for line in text.splitlines():
        if line.startswith("const ROWS"):
            in_rows = True
            continue
        if in_rows and line.startswith("];"):
            break
        m = _ROW.match(line) if in_rows else None
        if not m:
            continue
        cells = parse_row(m.group(1))
        if not 3 <= len(cells) <= 5:
            raise ValueError(f"bad row length: {line!r}")
        cells += [None] * (5 - len(cells))
        symbol, name, group, exchange, cap = cells
        if not isinstance(cap, (int, float)) or cap <= 0:
            cap = None
        rows.append([symbol, name, group, exchange or None, cap])
    return rows


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "apps/web/src/screener/universe"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "api/src/tickerglass_api/screener_data"
    out.mkdir(parents=True, exist_ok=True)
    for cls in CLASSES:
        rows = parse_ts((src / f"{cls}.ts").read_text())
        seen = [r[0] for r in rows]
        if len(set(seen)) != len(seen):
            raise SystemExit(f"{cls}: duplicate symbols")
        doc = {"asOf": AS_OF, "rows": rows}
        (out / f"{cls}.json").write_text(
            "{\n"
            f'  "asOf": {json.dumps(AS_OF)},\n'
            '  "rows": [\n'
            + ",\n".join("    " + json.dumps(r, ensure_ascii=False) for r in doc["rows"])
            + "\n  ]\n}\n"
        )
        print(f"{cls}: {len(rows)} rows")


if __name__ == "__main__":
    main()
