"""A small streaming `multipart/form-data` reader (stdlib only).

The restore upload can be gigabytes, so the body must go to disk as it arrives; Starlette's form
parsing needs `python-multipart`, which is not a dependency. This reader is fed the request body
chunk by chunk and reports parts through callbacks. It accepts what browsers' `FormData` sends
(RFC 7578): `--boundary`, part headers, a blank line, the content, `CRLF--boundary`, ..., and the
closing `--boundary--`. Anything else is a `MultipartError`."""

import re
from collections.abc import Callable
from dataclasses import dataclass

MAX_BOUNDARY = 70
MAX_HEADER_BYTES = 8192
_BOUNDARY = re.compile(r'boundary=(?:"([^"]{1,70})"|([^\s;",]{1,70}))', re.IGNORECASE)
_NAME = re.compile(r'(?:^|;)\s*name="((?:[^"\\]|\\.)*)"', re.IGNORECASE)
_FILENAME = re.compile(r'(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"', re.IGNORECASE)
_BOUNDARY_CHARS = re.compile(r"[0-9A-Za-z'()+_,\-./:=? ]+")


class MultipartError(ValueError):
    """The body is not valid multipart/form-data."""


@dataclass(frozen=True)
class PartInfo:
    name: str
    filename: str | None


def boundary_of(content_type: str | None) -> bytes:
    """The boundary of a `multipart/form-data` Content-Type; `MultipartError` otherwise."""
    if not content_type or not content_type.lower().lstrip().startswith("multipart/form-data"):
        raise MultipartError("expected multipart/form-data")
    match = _BOUNDARY.search(content_type)
    if match is None:
        raise MultipartError("missing multipart boundary")
    value = match.group(1) or match.group(2)
    if not _BOUNDARY_CHARS.fullmatch(value):
        raise MultipartError("invalid multipart boundary")
    return value.encode("ascii")


class MultipartReader:
    def __init__(
        self,
        boundary: bytes,
        on_start: Callable[[PartInfo], None],
        on_data: Callable[[bytes], None],
        on_end: Callable[[], None],
    ) -> None:
        self._delim = b"\r\n--" + boundary
        # The first boundary has no CRLF before it; start as if one had been seen.
        self._buf = bytearray(b"\r\n")
        self._state = "preamble"
        self._on_start = on_start
        self._on_data = on_data
        self._on_end = on_end

    @property
    def finished(self) -> bool:
        return self._state == "done"

    def feed(self, chunk: bytes) -> None:
        self._buf += chunk
        while self._step():
            pass

    def _step(self) -> bool:
        buf = self._buf
        keep = len(self._delim) - 1
        if self._state == "done":
            buf.clear()  # epilogue
            return False
        if self._state in ("preamble", "body"):
            index = buf.find(self._delim)
            if index < 0:
                if self._state == "body" and len(buf) > keep:
                    self._on_data(bytes(buf[:-keep]))
                    del buf[:-keep]
                elif self._state == "preamble" and len(buf) > keep:
                    del buf[:-keep]
                return False
            if self._state == "body":
                if index:
                    self._on_data(bytes(buf[:index]))
                self._on_end()
            del buf[: index + len(self._delim)]
            self._state = "after"
            return True
        if self._state == "after":
            if len(buf) < 2:
                return False
            if buf[:2] == b"--":
                self._state = "done"
                buf.clear()
                return False
            if buf[:2] != b"\r\n":
                raise MultipartError("malformed multipart boundary line")
            del buf[:2]
            self._state = "headers"
            return True
        # headers
        end = buf.find(b"\r\n\r\n")
        if end < 0:
            if len(buf) > MAX_HEADER_BYTES:
                raise MultipartError("multipart headers too large")
            return False
        if end > MAX_HEADER_BYTES:
            raise MultipartError("multipart headers too large")
        raw = bytes(buf[:end]).decode("utf-8", errors="replace")
        del buf[: end + 4]
        self._state = "body"
        self._on_start(self._part_info(raw))
        return True

    @staticmethod
    def _part_info(raw: str) -> PartInfo:
        disposition = ""
        for line in raw.split("\r\n"):
            key, _, value = line.partition(":")
            if key.strip().lower() == "content-disposition":
                disposition = value.strip()
        if not disposition.lower().startswith("form-data"):
            raise MultipartError("multipart part without form-data disposition")
        name = _NAME.search(disposition)
        if name is None:
            raise MultipartError("multipart part without a name")
        filename = _FILENAME.search(disposition)
        return PartInfo(name.group(1), filename.group(1) if filename else None)

    def close(self) -> None:
        """Call after the last chunk: the closing boundary must have been seen."""
        if self._state != "done":
            raise MultipartError("truncated multipart body")
