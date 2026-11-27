"""In-process fake OpenAI-compatible server: `GET /v1/models` and a streamed (SSE)
`POST /v1/chat/completions`. Tests set `.models` / `.events` / `.status` and read `.requests`."""

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class FakeOpenAI:
    def __init__(self) -> None:
        self.models = ["gpt-test", "glm-test"]
        self.status = 200
        self.events: list[Any] = [
            {"choices": [{"delta": {"reasoning_content": "hmm"}}]},
            {"choices": [{"delta": {"content": "Up "}}]},
            {"choices": [{"delta": {"content": "trend."}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 2}},
            "[DONE]",
        ]
        self.requests: list[dict[str, Any]] = []
        self.url = ""


def _handler(fake: FakeOpenAI) -> type[BaseHTTPRequestHandler]:
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a: Any) -> None:
            pass

        def _json(self, status: int, obj: Any) -> None:
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": None})
            if self.headers.get("Authorization") != "Bearer sk-test-1234":
                self._json(401, {"error": {"message": "bad key"}})
            elif self.path == "/v1/models":
                self._json(200, {"data": [{"id": m} for m in fake.models]})
            else:
                self._json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n)) if n else None
            fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
            if fake.status != 200:
                self._json(fake.status, {"error": {"message": "nope"}})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for ev in fake.events:
                data = ev if isinstance(ev, str) else json.dumps(ev)
                self.wfile.write(f": ping\n\ndata: {data}\n\n".encode())
                self.wfile.flush()
            self.close_connection = True

    return H


@contextmanager
def serve() -> Iterator[FakeOpenAI]:
    fake = FakeOpenAI()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(fake))
    fake.url = f"http://127.0.0.1:{server.server_port}/v1"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()
