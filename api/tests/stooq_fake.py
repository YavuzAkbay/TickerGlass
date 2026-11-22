"""A Stooq server for tests: a `Send` answering from the CSV files in `tests/fixtures/stooq/`
(hand-built from the documented response shapes), so nothing touches the network."""

from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "stooq"
KEY = "stooq-test-key-0123456789"

Answer = tuple[int, dict[str, str], bytes]

#: (Stooq symbol, `i=` value) -> fixture holding its bars.
SERIES = {
    ("aapl.us", "d"): "aapl_d.csv",
    ("aapl.us", "w"): "aapl_w.csv",
    ("aapl.us", "m"): "aapl_m.csv",
    ("vod.uk", "d"): "vod_uk_d.csv",
    ("vod.uk", "m"): "vod_uk_d.csv",
    ("^spx", "d"): "spx_d.csv",
    ("^spx", "m"): "spx_d.csv",
}


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class FakeStooq:
    """Callable `Send`. `calls` records (path, params, request headers) and `urls` the raw
    URLs; `answers` maps a path to a function `(params) -> (status, headers, body)` replacing
    the default route. A request without `key` as `apikey` gets the HTML page of a missing
    or expired key, as the real server does."""

    def __init__(self, key: str = KEY) -> None:
        self.key = key
        self.calls: list[tuple[str, dict[str, str], Mapping[str, str]]] = []
        self.urls: list[str] = []
        self.answers: dict[str, Callable[[dict[str, str]], Answer]] = {}

    def paths(self) -> list[str]:
        return [path for path, _, _ in self.calls]

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        parts = urlsplit(url)
        params = dict(parse_qsl(parts.query, keep_blank_values=True))
        self.urls.append(url)
        self.calls.append((parts.path, params, dict(headers)))
        handler = self.answers.get(parts.path)
        if handler is not None:
            return handler(params)
        if params.get("apikey") != self.key:
            return 200, {"content-type": "text/html"}, fixture("key_page.html")
        return self.route(parts.path, params)

    def route(self, path: str, params: dict[str, str]) -> Answer:
        match path:
            case "/q/d/l/":
                return self._bars(params)
            case "/q/l/":
                return 200, {}, self._quotes(params["s"].split())
        return 404, {}, b"not found"

    @staticmethod
    def _bars(params: dict[str, str]) -> Answer:
        name = SERIES.get((params["s"], params.get("i", "d")))
        if name is None:
            return 200, {}, fixture("no_data.txt")
        lines = fixture(name).decode().splitlines()
        first, last = params.get("d1"), params.get("d2")
        rows = [
            line
            for line in lines[1:]
            if (first is None or line[:10].replace("-", "") >= first)
            and (last is None or line[:10].replace("-", "") <= last)
        ]
        if not rows:
            return 200, {}, fixture("no_data.txt")
        return 200, {}, "\n".join([lines[0], *rows, ""]).encode()

    @staticmethod
    def _quotes(symbols: list[str]) -> bytes:
        lines = fixture("quote_batch.csv").decode().splitlines()
        by_symbol = {line.split(",")[0].lower(): line for line in lines[1:]}
        out = [lines[0]]
        for s in symbols:
            out.append(by_symbol.get(s.lower(), f"{s.upper()},N/D,N/D,N/D,N/D,N/D,N/D,N/D"))
        return ("\n".join(out) + "\n").encode()
