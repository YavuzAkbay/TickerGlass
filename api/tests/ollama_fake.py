"""In-process fake Ollama: `/api/tags`, `/api/show` and a chunked NDJSON `/api/chat`.

Tests set `FakeOllama.models` / `.capabilities` / `.chat_lines` / `.chat_status` and read back
`.requests` (path, headers, JSON body) and `.disconnected` (the chat client went away).
"""

import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class FakeOllama:
    def __init__(self) -> None:
        self.models: list[dict[str, Any]] = [
            {"name": "qwen2.5:7b", "size": 4_700_000_000, "details": {"parameter_size": "7.6B"}},
            {"name": "llava:latest", "size": 4_000_000_000, "details": {"families": ["clip"]}},
            {"name": "gemma3:4b", "size": 3_300_000_000, "details": {"parameter_size": "4.3B"}},
            {"name": "nomic-embed-text:latest", "size": 270_000_000, "details": {}},
        ]
        #: Per model; a missing entry answers `/api/show` without `capabilities` (old Ollama).
        self.capabilities: dict[str, list[str]] = {
            "qwen2.5:7b": ["completion", "tools"],
            "gemma3:4b": ["completion", "vision"],
            "nomic-embed-text:latest": ["embedding"],
        }
        self.chat_status = 200
        self.chat_lines: list[Any] = [
            {"message": {"role": "assistant", "content": "Up "}, "done": False},
            {"message": {"role": "assistant", "content": "trend."}, "done": False},
            {
                "message": {"role": "assistant", "content": ""},
                "done": True,
                "done_reason": "stop",
                "total_duration": 1_500_000_000,
                "prompt_eval_count": 120,
                "eval_count": 2,
            },
        ]
        #: Seconds to sleep before each chat line.
        self.line_delay_s = 0.0
        #: Seconds before the chat response starts (Ollama sends headers with the first token).
        self.header_delay_s = 0.0
        self.requests: list[dict[str, Any]] = []
        self.disconnected = threading.Event()
        self.url = ""


def _handler(fake: FakeOllama) -> type[BaseHTTPRequestHandler]:
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a: Any) -> None:
            pass

        def _body(self) -> Any:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw) if raw else None

        def _send_json(self, status: int, obj: Any) -> None:
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _record(self, body: Any) -> None:
            fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})

        def do_GET(self) -> None:
            self._record(None)
            if self.path.endswith("/api/tags"):
                self._send_json(200, {"models": fake.models})
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:
            body = self._body()
            self._record(body)
            if self.path.endswith("/api/show"):
                name = body["model"]
                if name in fake.capabilities:
                    self._send_json(200, {"capabilities": fake.capabilities[name]})
                else:
                    self._send_json(200, {"details": {}})
            elif self.path.endswith("/api/chat"):
                self._chat()
            else:
                self._send_json(404, {"error": "not found"})

        def _chat(self) -> None:
            if fake.header_delay_s:
                time.sleep(fake.header_delay_s)
            if fake.chat_status != 200:
                self._send_json(fake.chat_status, {"error": "model 'x' not found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                for line in fake.chat_lines:
                    if fake.line_delay_s:
                        time.sleep(fake.line_delay_s)
                    data = (line if isinstance(line, bytes) else json.dumps(line).encode()) + b"\n"
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                fake.disconnected.set()

    return H


class _Server(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # a client cutting the stream (abort tests) is expected


@contextmanager
def serve(fake: FakeOllama | None = None) -> Iterator[FakeOllama]:
    fake = fake or FakeOllama()
    server = _Server(("127.0.0.1", 0), _handler(fake))
    server.daemon_threads = True
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()
