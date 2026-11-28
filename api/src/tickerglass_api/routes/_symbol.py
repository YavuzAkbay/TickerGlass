"""One validator for a ticker symbol taken from a URL (path or query)."""

import re
from typing import Annotated, Any

from pydantic import BeforeValidator

MAX_SYMBOL_LEN = 32
# Whitespace and control characters, backslash and URL delimiters never belong to a ticker
# (providers use letters, digits and `. - = ^ / : & _`, e.g. BRK.B, ^GSPC, EURUSD=X, BTC/USD).
_FORBIDDEN = re.compile(r"[\s\x00-\x1f\x7f\\?#%]")


def clean_symbol(value: Any) -> str:
    """Strip surrounding whitespace (as `/quotes` does) and reject what cannot be a symbol: empty,
    over `MAX_SYMBOL_LEN`, inner whitespace/control characters, URL delimiters and `..`
    (which would walk a path in a provider URL). Case is left to the services, which upper-case."""
    if not isinstance(value, str):
        raise ValueError("symbol must be a string")
    sym = value.strip()
    if not 1 <= len(sym) <= MAX_SYMBOL_LEN:
        raise ValueError(f"symbol must be 1-{MAX_SYMBOL_LEN} characters")
    if _FORBIDDEN.search(sym) or ".." in sym:
        raise ValueError("symbol contains invalid characters")
    return sym


SymbolParam = Annotated[str, BeforeValidator(clean_symbol)]
