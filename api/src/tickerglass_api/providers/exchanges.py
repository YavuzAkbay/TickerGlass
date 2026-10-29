"""Exchange table shared by providers that identify listings by exchange rather than by
Yahoo suffix: ISO 10383 MIC <-> Yahoo symbol suffix, IANA time zone and regular session.

Canonical symbols are Yahoo-style (`VOD.L`); a provider maps the suffix to its own exchange
code and back. Sessions are the regular continuous session in local time (lunch breaks and
auctions ignored), as `services.sessions.TradingHours` reads them.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Exchange:
    mic: str
    #: Yahoo symbol suffix including the dot ("" for US listings).
    yahoo_suffix: str
    #: IANA time zone of the exchange.
    timezone: str
    #: Regular session "HHMM-HHMM" in `timezone`.
    session: str
    #: Other names an upstream may report for the exchange (lower-cased on lookup).
    aliases: tuple[str, ...]
    #: Exchange code of the Twelve Data API (`exchange=` parameter and `exchange` field).
    td_code: str


EXCHANGES: dict[str, Exchange] = {
    e.mic: e
    for e in (
        Exchange("XNAS", "", "America/New_York", "0930-1600", ("NASDAQ", "NMS", "NGM"), "NASDAQ"),
        Exchange("XNYS", "", "America/New_York", "0930-1600", ("NYSE", "NYQ"), "NYSE"),
        # td_code unverified for ARCX and BATS.
        Exchange(
            "ARCX",
            "",
            "America/New_York",
            "0930-1600",
            ("NYSE ARCA", "NYSEARCA", "PCX"),
            "NYSE ARCA",
        ),
        Exchange("BATS", "", "America/New_York", "0930-1600", ("CBOE", "BZX", "BTS"), "CBOE"),
        Exchange("XLON", ".L", "Europe/London", "0800-1630", ("LSE", "LONDON", "LON"), "LSE"),
        Exchange("XETR", ".DE", "Europe/Berlin", "0900-1730", ("XETRA", "GER", "ETR"), "XETR"),
        # Euronext venues share one Twelve Data code; the MIC tells them apart.
        Exchange("XPAR", ".PA", "Europe/Paris", "0900-1730", ("EURONEXT PARIS", "PAR"), "Euronext"),
        Exchange(
            "XAMS",
            ".AS",
            "Europe/Amsterdam",
            "0900-1730",
            ("EURONEXT AMSTERDAM", "AMS"),
            "Euronext",
        ),
        Exchange("XTSE", ".TO", "America/Toronto", "0930-1600", ("TSX", "TOR"), "TSX"),
        Exchange("XASX", ".AX", "Australia/Sydney", "1000-1600", ("ASX",), "ASX"),
        Exchange("XHKG", ".HK", "Asia/Hong_Kong", "0930-1600", ("HKEX", "HKG"), "HKEX"),
        # The Tokyo session ends 15:30 since November 2024.
        Exchange("XTKS", ".T", "Asia/Tokyo", "0900-1530", ("JPX", "TSE", "JPN"), "JPX"),
        Exchange("XSWX", ".SW", "Europe/Zurich", "0900-1730", ("SIX", "EBS"), "SIX"),
        # td_code unverified for XMIL ("MTA" is Borsa Italiana's market name) and XMAD ("BME").
        Exchange(
            "XMIL", ".MI", "Europe/Rome", "0900-1730", ("MTA", "MIL", "BORSA ITALIANA"), "MTA"
        ),
        Exchange("XMAD", ".MC", "Europe/Madrid", "0900-1730", ("BME", "MCE", "MAD"), "BME"),
    )
}

_BY_SUFFIX: dict[str, Exchange] = {}
for _e in EXCHANGES.values():
    if _e.yahoo_suffix:
        _BY_SUFFIX[_e.yahoo_suffix.upper()] = _e
_BY_NAME: dict[str, Exchange] = {}
for _e in EXCHANGES.values():
    for _name in (_e.mic, _e.td_code, *_e.aliases):
        _BY_NAME.setdefault(_name.upper(), _e)

#: MICs of exchanges whose Yahoo symbols have no suffix.
US_MICS = frozenset(e.mic for e in EXCHANGES.values() if not e.yahoo_suffix)


def by_mic(mic: str) -> Exchange | None:
    """The exchange with this MIC (case-insensitive), or None when not in the table."""
    return EXCHANGES.get(mic.strip().upper())


def by_suffix(suffix: str) -> Exchange | None:
    """The exchange of a Yahoo symbol suffix, with or without the dot (`".L"` or `"L"`).
    None for an unknown suffix and for "": US listings span several exchanges (`US_MICS`)."""
    key = suffix.strip().upper()
    if key and not key.startswith("."):
        key = "." + key
    return _BY_SUFFIX.get(key)


def by_name(name: str) -> Exchange | None:
    """The exchange an upstream calls `name` (MIC, Twelve Data code or alias,
    case-insensitive). Venues sharing a code (Euronext) resolve to the first in the table."""
    return _BY_NAME.get(name.strip().upper())


def split_symbol(symbol: str) -> tuple[str, Exchange | None]:
    """Split a canonical symbol into its base ticker and the exchange its suffix names:
    `"VOD.L"` -> `("VOD", XLON)`; no known suffix -> `(symbol, None)`."""
    base, dot, suffix = symbol.rpartition(".")
    if dot and base:
        exchange = by_suffix(suffix)
        if exchange is not None:
            return base, exchange
    return symbol, None
