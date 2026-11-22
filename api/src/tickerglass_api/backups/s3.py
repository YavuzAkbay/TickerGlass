"""Minimal S3 client (stdlib only): SigV4, path/virtual-host style, streaming PUT/GET.

Works against AWS S3 and S3-compatible stores (MinIO, Backblaze B2, Wasabi, Garage, R2). The
endpoint is operator-configured, so private addresses are allowed; redirects are never followed
(`http.client` does not), only http/https endpoints are accepted, and every request is signed with
the real payload hash (`UNSIGNED-PAYLOAD` is not used).

Keys passed to `S3Client` are *full* object keys: the client never prepends `S3Config.prefix`.
Use `S3Client.full_key(name)` to build a key under the configured prefix.

`S3Error.code` is the S3 XML error `Code` (`AccessDenied`, `NoSuchBucket`, ...), or `network`,
`http_<status>`, `bad_response`, `too_large`, `invalid_config`, `invalid_request`. Error text never
contains credentials, signatures, or URLs.
"""

import hashlib
import hmac
import http.client
import re
import urllib.parse
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import BinaryIO
from xml.parsers import expat

CHUNK = 1 << 20
MAX_PUT_SIZE = 5 * (1 << 30)  # single PUT limit
MAX_ERROR_BODY = 64 * 1024
MAX_LIST_BODY = 16 * (1 << 20)
MAX_LIST_PAGES = 100_000
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

_CODE_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")


@dataclass
class S3Config:
    endpoint: str
    bucket: str
    prefix: str
    region: str
    access_key_id: str
    secret_access_key: str
    path_style: bool


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int
    last_modified: datetime


class S3Error(Exception):
    """An S3 request failed. `code` is safe to show; the message carries nothing else."""

    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(f"S3 request failed: {code}")
        self.code = code
        self.status = status


# --- SigV4 ---------------------------------------------------------------------------------


def uri_encode(value: str, *, keep_slash: bool = False) -> str:
    """AWS URI encoding: only `A-Za-z0-9-_.~` stay literal (and `/` in paths), upper-case hex."""
    return urllib.parse.quote(value, safe="/~" if keep_slash else "~")


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sign_headers(
    *,
    method: str,
    host: str,
    path: str,
    query: list[tuple[str, str]],
    headers: dict[str, str],
    payload_hash: str,
    amz_date: str,
    access_key_id: str,
    secret_access_key: str,
    region: str,
) -> dict[str, str]:
    """SigV4 for service `s3`.

    `path` is the already URI-encoded absolute path; `query` holds decoded pairs; `headers` are
    extra headers to sign (besides `host`, `x-amz-content-sha256`, `x-amz-date`). Returns the
    headers to send: those two `x-amz-*` ones, `headers` themselves and `Authorization`.
    """
    all_headers = {k.lower(): " ".join(v.split()) for k, v in headers.items()}
    all_headers["host"] = host
    all_headers["x-amz-content-sha256"] = payload_hash
    all_headers["x-amz-date"] = amz_date
    names = sorted(all_headers)
    canonical_headers = "".join(f"{n}:{all_headers[n]}\n" for n in names)
    signed = ";".join(names)
    canonical_query = "&".join(
        f"{k}={v}" for k, v in sorted((uri_encode(k), uri_encode(v)) for k, v in query)
    )
    canonical = "\n".join([method, path, canonical_query, canonical_headers, signed, payload_hash])
    day = amz_date[:8]
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()]
    )
    key = _hmac(("AWS4" + secret_access_key).encode("utf-8"), day)
    for part in (region, "s3", "aws4_request"):
        key = _hmac(key, part)
    signature = hmac.new(key, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    out = {k: v for k, v in all_headers.items() if k != "host"}
    out["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, "
        f"SignedHeaders={signed}, Signature={signature}"
    )
    return out


# --- XML -----------------------------------------------------------------------------------


class _UnsafeXML(Exception):
    pass


def _reject(*_: object) -> None:
    raise _UnsafeXML


def _parse_xml(body: bytes) -> ET.Element:
    """Parse `body` into an element tree, refusing any DOCTYPE or entity declaration.

    Built on expat directly (the accelerated `ElementTree` parser does not expose its handlers);
    namespaces are kept as `uri}local` prefixes, which callers strip with `_local`.
    """
    stack: list[ET.Element] = []
    roots: list[ET.Element] = []

    def start(name: str, attrs: dict[str, str]) -> None:
        node = ET.Element(name, attrs)
        if stack:
            stack[-1].append(node)
        else:
            roots.append(node)
        stack.append(node)

    def end(_name: str) -> None:
        stack.pop()

    def text(data: str) -> None:
        node = stack[-1]
        node.text = (node.text or "") + data

    parser = expat.ParserCreate(namespace_separator="}")
    parser.StartDoctypeDeclHandler = _reject
    parser.EntityDeclHandler = _reject
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    try:
        parser.Parse(body, True)
    except (_UnsafeXML, expat.ExpatError):
        raise S3Error("bad_response") from None
    if not roots:
        raise S3Error("bad_response")
    return roots[0]


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def _child_text(node: ET.Element, name: str) -> str | None:
    for child in node:
        if _local(child.tag) == name:
            return child.text or ""
    return None


def _parse_time(text: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise S3Error("bad_response") from None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


# --- client --------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Target:
    https: bool
    connect_host: str
    port: int
    host_header: str
    path: str  # URI-encoded, absolute


class S3Client:
    def __init__(self, config: S3Config, *, timeout: float = 60.0) -> None:
        self._cfg = config
        self._timeout = timeout
        try:
            parts = urllib.parse.urlsplit(config.endpoint)
            host, port = parts.hostname, parts.port
        except ValueError:
            raise S3Error("invalid_config") from None
        if (
            parts.scheme not in ("http", "https")
            or not host
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
            or not config.bucket
            or "/" in config.bucket
        ):
            raise S3Error("invalid_config")
        self._https = parts.scheme == "https"
        self._host = host
        self._port = port or (443 if self._https else 80)
        self._base = parts.path.rstrip("/")

    def full_key(self, name: str) -> str:
        """`name` under the configured prefix (a missing trailing `/` on the prefix is added)."""
        prefix = self._cfg.prefix
        if prefix and not prefix.endswith("/"):
            prefix += "/"
        return prefix + name

    def _target(self, key: str | None) -> _Target:
        host = self._host
        if not self._cfg.path_style:
            host = f"{self._cfg.bucket}.{host}"
        if ":" in host:  # IPv6 literal
            host = f"[{host}]"
        default_port = 443 if self._https else 80
        host_header = host if self._port == default_port else f"{host}:{self._port}"
        if self._cfg.path_style:
            path = f"{self._base}/{self._cfg.bucket}"
            if key is not None:
                path += "/" + key
        else:
            path = f"{self._base}/{key if key is not None else ''}"
        return _Target(
            self._https,
            host.strip("[]"),
            self._port,
            host_header,
            uri_encode(path, keep_slash=True),
        )

    @contextmanager
    def _request(
        self,
        method: str,
        key: str | None,
        query: list[tuple[str, str]] | None = None,
        *,
        payload_hash: str = EMPTY_SHA256,
        body: BinaryIO | None = None,
        size: int = 0,
    ) -> Iterator[http.client.HTTPResponse]:
        """Send one signed request; yields a 2xx response, raises `S3Error` otherwise."""
        target = self._target(key)
        query = query or []
        amz_date = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        headers = sign_headers(
            method=method,
            host=target.host_header,
            path=target.path,
            query=query,
            headers={},
            payload_hash=payload_hash,
            amz_date=amz_date,
            access_key_id=self._cfg.access_key_id,
            secret_access_key=self._cfg.secret_access_key,
            region=self._cfg.region,
        )
        url = target.path
        if query:
            url += "?" + "&".join(f"{uri_encode(k)}={uri_encode(v)}" for k, v in query)
        conn_cls = http.client.HTTPSConnection if target.https else http.client.HTTPConnection
        conn = conn_cls(target.connect_host, target.port, timeout=self._timeout)
        try:
            send_error: OSError | None = None
            try:
                conn.putrequest(method, url, skip_host=True, skip_accept_encoding=True)
                conn.putheader("Host", target.host_header)
                for name, value in headers.items():
                    conn.putheader(name, value)
                conn.putheader("User-Agent", "TickerGlass-Backup")
                if body is not None:
                    conn.putheader("Content-Length", str(size))
                conn.endheaders()
                if body is not None:
                    remaining = size
                    while remaining > 0:
                        chunk = body.read(min(CHUNK, remaining))
                        if not chunk:
                            raise S3Error("invalid_request")  # file shorter than `size`
                        conn.send(chunk)
                        remaining -= len(chunk)
            except OSError as exc:
                # The server may have answered (and closed) before the body was done.
                send_error = exc
            except http.client.HTTPException:
                raise S3Error("network") from None
            if send_error is not None and conn.sock is None:
                raise S3Error("network")  # never connected
            try:
                resp = conn.getresponse()
            except (OSError, http.client.HTTPException):
                raise S3Error("network") from None
            if not 200 <= resp.status < 300:
                raise self._error(resp, method)
            if send_error is not None:
                raise S3Error("network")
            try:
                yield resp
            except (OSError, http.client.HTTPException):
                raise S3Error("network") from None
        finally:
            conn.close()

    @staticmethod
    def _error(resp: http.client.HTTPResponse, method: str) -> S3Error:
        fallback = f"http_{resp.status}"
        if method == "HEAD":
            return S3Error(fallback, resp.status)
        try:
            body = resp.read(MAX_ERROR_BODY)
            code = _child_text(_parse_xml(body), "Code")
        except (OSError, http.client.HTTPException, S3Error):
            return S3Error(fallback, resp.status)
        if code and _CODE_RE.fullmatch(code):
            return S3Error(code, resp.status)
        return S3Error(fallback, resp.status)

    def put_object(self, key: str, fileobj: BinaryIO, size: int, sha256_hex: str) -> None:
        if size > MAX_PUT_SIZE:
            raise S3Error("too_large")
        if size < 0 or not _SHA256_RE.fullmatch(sha256_hex):
            raise S3Error("invalid_request")
        with self._request("PUT", key, payload_hash=sha256_hex, body=fileobj, size=size) as resp:
            resp.read()

    def list_objects(self, prefix: str) -> list[S3Object]:
        found: list[S3Object] = []
        token: str | None = None
        seen: set[str] = set()
        for _ in range(MAX_LIST_PAGES):
            query = [("list-type", "2"), ("prefix", prefix)]
            if token is not None:
                query.append(("continuation-token", token))
            with self._request("GET", None, query) as resp:
                root = _parse_xml(resp.read(MAX_LIST_BODY))
            truncated = False
            token = None
            for node in root:
                name = _local(node.tag)
                if name == "Contents":
                    key = _child_text(node, "Key")
                    size = _child_text(node, "Size")
                    modified = _child_text(node, "LastModified")
                    if key is None or size is None or modified is None or not size.isdigit():
                        raise S3Error("bad_response")
                    found.append(S3Object(key, int(size), _parse_time(modified)))
                elif name == "IsTruncated":
                    truncated = (node.text or "").strip().lower() == "true"
                elif name == "NextContinuationToken":
                    token = node.text or ""
            if not truncated:
                return found
            if not token or token in seen:
                raise S3Error("bad_response")
            seen.add(token)
        raise S3Error("bad_response")

    def get_object(self, key: str, dst: BinaryIO) -> None:
        with self._request("GET", key) as resp:
            expected = resp.getheader("Content-Length")
            total = 0
            while chunk := resp.read(CHUNK):
                dst.write(chunk)
                total += len(chunk)
            if expected is not None and expected.isdigit() and total != int(expected):
                raise S3Error("network")

    def delete_object(self, key: str) -> None:
        with self._request("DELETE", key) as resp:
            resp.read()

    def head_bucket(self) -> None:
        with self._request("HEAD", None) as resp:
            resp.read()
