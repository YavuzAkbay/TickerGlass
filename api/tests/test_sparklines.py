import threading
from pathlib import Path

import pandas as pd
from fastapi.testclient import TestClient
from test_bars import DAILY, FakeProvider

from tickerglass_api.app import create_app
from tickerglass_api.providers.base import ProviderError
from tickerglass_api.providers.guard import UpstreamGuard
from tickerglass_api.routes.bars import SPARKLINE_WORKERS


class SpyProvider(FakeProvider):
    def __init__(self, frames: dict[tuple[str, str], pd.DataFrame]) -> None:
        super().__init__(frames)
        self.priorities: list[str] = []

    def history(self, symbol, interval, start, end, prepost):  # type: ignore[no-untyped-def]
        self.priorities.append(UpstreamGuard.current_priority())
        if symbol == "BOOM":
            raise ProviderError("upstream exploded")
        return super().history(symbol, interval, start, end, prepost)


def make_client(tmp_path: Path, provider: FakeProvider) -> TestClient:
    return TestClient(create_app(provider=provider, database_url=f"sqlite:///{tmp_path}/a.db"))


def test_sparklines_shape_dedupe_and_per_symbol_null(tmp_path: Path) -> None:
    provider = SpyProvider({("AAPL", "1d"): DAILY})
    with make_client(tmp_path, provider) as client:
        res = client.get("/api/sparklines", params={"symbols": "aapl, AAPL,NOPE,BOOM,", "limit": 5})
        assert res.status_code == 200
        body = res.json()
        assert list(body) == ["AAPL", "NOPE", "BOOM"]
        assert body["NOPE"] is None and body["BOOM"] is None
        spark = body["AAPL"]
        assert spark["closes"] == DAILY["close"].tolist()[-5:]
        assert spark["time"] == DAILY["ts"].tolist()[-5:]
        # Some symbols came back null (maybe transient): not browser-cacheable.
        assert res.headers["cache-control"] == "private, no-cache"
    assert provider.priorities and set(provider.priorities) == {"background"}


def test_sparklines_cacheable_only_when_all_symbols_resolve(tmp_path: Path) -> None:
    provider = SpyProvider({("AAPL", "1d"): DAILY})
    with make_client(tmp_path, provider) as client:
        res = client.get("/api/sparklines", params={"symbols": "AAPL"})
        assert res.status_code == 200
        assert res.headers["cache-control"] == "private, max-age=60"


def test_sparklines_share_one_bounded_pool(tmp_path: Path) -> None:
    provider = SpyProvider({("AAPL", "1d"): DAILY})
    with make_client(tmp_path, provider) as client:
        for _ in range(3):
            res = client.get("/api/sparklines", params={"symbols": "AAPL,NOPE,BOOM,X1,X2,X3"})
            assert res.status_code == 200
    names = {t.name for t in threading.enumerate() if t.name.startswith("sparkline")}
    assert len(names) <= SPARKLINE_WORKERS


def test_sparklines_reuse_cached_bars(tmp_path: Path) -> None:
    provider = SpyProvider({("AAPL", "1d"): DAILY})
    with make_client(tmp_path, provider) as client:
        client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"})
        calls = len(provider.calls)
        res = client.get("/api/sparklines", params={"symbols": "AAPL"})
        assert res.status_code == 200 and res.json()["AAPL"] is not None
        assert len(provider.calls) == calls


def test_sparklines_validation(tmp_path: Path) -> None:
    with make_client(tmp_path, SpyProvider({})) as client:
        assert client.get("/api/sparklines", params={"symbols": " , "}).status_code == 422
        assert client.get("/api/sparklines").status_code == 422
        too_many = ",".join(f"S{i}" for i in range(51))
        assert client.get("/api/sparklines", params={"symbols": too_many}).status_code == 422
        assert client.get("/api/sparklines", params={"symbols": "A", "limit": 1}).status_code == 422
        ok = ",".join(f"S{i}" for i in range(50))
        res = client.get("/api/sparklines", params={"symbols": ok})
        assert res.status_code == 200 and len(res.json()) == 50
