from zoneinfo import ZoneInfo

import pytest

from tickerglass_api.providers.exchanges import (
    EXCHANGES,
    US_MICS,
    by_mic,
    by_name,
    by_suffix,
    split_symbol,
)
from tickerglass_api.services.sessions import TradingHours


def test_table_is_self_consistent() -> None:
    suffixes = [e.yahoo_suffix for e in EXCHANGES.values() if e.yahoo_suffix]
    assert len(suffixes) == len(set(suffixes))
    for mic, e in EXCHANGES.items():
        assert e.mic == mic and e.td_code
        ZoneInfo(e.timezone)
        info = {"type": "equity", "timezone": e.timezone, "session": e.session}
        assert TradingHours.from_symbol_info(info) is not None, mic
    assert {"XNAS", "XNYS", "ARCX", "BATS"} == US_MICS


def test_lookup_by_mic_and_suffix() -> None:
    assert by_mic("xlon") is EXCHANGES["XLON"]
    assert by_mic("XXXX") is None
    assert by_suffix(".L") is by_suffix("l") is EXCHANGES["XLON"]
    assert by_suffix(".DE") is EXCHANGES["XETR"]
    assert by_suffix("") is None and by_suffix(".ZZ") is None


def test_lookup_by_name_covers_mic_td_code_and_alias() -> None:
    assert by_name("LSE") is EXCHANGES["XLON"]
    assert by_name("nasdaq") is EXCHANGES["XNAS"]
    assert by_name("XETR") is EXCHANGES["XETR"]
    assert by_name("Euronext") is EXCHANGES["XPAR"]
    assert by_name("nowhere") is None


@pytest.mark.parametrize(
    ("symbol", "base", "mic"),
    [
        ("VOD.L", "VOD", "XLON"),
        ("SAP.DE", "SAP", "XETR"),
        ("7203.T", "7203", "XTKS"),
        ("BRK.B", "BRK.B", None),
        ("AAPL", "AAPL", None),
        ("^GSPC", "^GSPC", None),
        (".L", ".L", None),
    ],
)
def test_split_symbol(symbol: str, base: str, mic: str | None) -> None:
    got_base, exchange = split_symbol(symbol)
    assert got_base == base
    assert (exchange.mic if exchange else None) == mic
