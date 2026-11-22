import hashlib
import http.server
import io
import threading
import urllib.parse
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tickerglass_api.backups import s3 as s3mod
from tickerglass_api.backups.s3 import EMPTY_SHA256, S3Client, S3Config, S3Error, sign_headers

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"  # AWS docs example credentials
AWS_KW: dict[str, Any] = {
    "host": "examplebucket.s3.amazonaws.com",
    "amz_date": "20130524T000000Z",
    "access_key_id": AWS_KEY,
    "secret_access_key": AWS_SECRET,
    "region": "us-east-1",
}


def signature_of(headers: dict[str, str]) -> str:
    return headers["Authorization"].rsplit("Signature=", 1)[1]


# --- AWS published SigV4 test vectors -------------------------------------------------------


def test_sigv4_get_object_range_vector() -> None:
    h = sign_headers(
        method="GET",
        path="/test.txt",
        query=[],
        headers={"Range": "bytes=0-9"},
        payload_hash=EMPTY_SHA256,
        **AWS_KW,
    )
    assert signature_of(h) == "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    assert h["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature="
    )
    assert h["x-amz-content-sha256"] == EMPTY_SHA256
    assert h["x-amz-date"] == "20130524T000000Z"


def test_sigv4_get_lifecycle_vector() -> None:
    h = sign_headers(
        method="GET",
        path="/",
        query=[("lifecycle", "")],
        headers={},
        payload_hash=EMPTY_SHA256,
        **AWS_KW,
    )
    assert signature_of(h) == "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"


def test_sigv4_list_objects_vector() -> None:
    h = sign_headers(
        method="GET",
        path="/",
        query=[("prefix", "J"), ("max-keys", "2")],  # order must not matter
        headers={},
        payload_hash=EMPTY_SHA256,
        **AWS_KW,
    )
    assert signature_of(h) == "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"


def test_sigv4_put_object_vector() -> None:
    h = sign_headers(
        method="PUT",
        path="/test%24file.text",
        query=[],
        headers={
            "Date": "Fri, 24 May 2013 00:00:00 GMT",
            "x-amz-storage-class": "REDUCED_REDUNDANCY",
        },
        payload_hash=hashlib.sha256(b"Welcome to Amazon S3.").hexdigest(),
        **AWS_KW,
    )
    assert signature_of(h) == "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"


# --- URL building and key encoding ----------------------------------------------------------


def cfg(**over: Any) -> S3Config:
    base: dict[str, Any] = {
        "endpoint": "https://s3.eu-central-1.amazonaws.com",
        "bucket": "my-bucket",
        "prefix": "tickerglass/",
        "region": "eu-central-1",
        "access_key_id": AWS_KEY,
        "secret_access_key": AWS_SECRET,
        "path_style": True,
    }
    base.update(over)
    return S3Config(**base)


def test_path_style_target() -> None:
    t = S3Client(cfg())._target("tickerglass/a.db.gz")
    assert (t.https, t.connect_host, t.port) == (True, "s3.eu-central-1.amazonaws.com", 443)
    assert t.host_header == "s3.eu-central-1.amazonaws.com"
    assert t.path == "/my-bucket/tickerglass/a.db.gz"
    assert S3Client(cfg())._target(None).path == "/my-bucket"


def test_virtual_host_target() -> None:
    client = S3Client(cfg(path_style=False))
    t = client._target("tickerglass/a.db.gz")
    assert t.connect_host == "my-bucket.s3.eu-central-1.amazonaws.com"
    assert t.host_header == "my-bucket.s3.eu-central-1.amazonaws.com"
    assert t.path == "/tickerglass/a.db.gz"
    assert client._target(None).path == "/"


def test_custom_port_and_base_path() -> None:
    t = S3Client(cfg(endpoint="http://minio:9000/"))._target("k")
    assert (t.https, t.port, t.host_header, t.path) == (False, 9000, "minio:9000", "/my-bucket/k")
    t = S3Client(cfg(endpoint="https://gw.example.com:443/s3/"))._target("k")
    assert (t.host_header, t.path) == ("gw.example.com", "/s3/my-bucket/k")
    t = S3Client(cfg(endpoint="http://host:80"))._target("k")
    assert t.host_header == "host"


def test_key_encoding() -> None:
    client = S3Client(cfg())
    path = client._target("tickerglass/my file+1 ü日本/a~b-c_d.e$f&g=h,i;j'k(l)*m!n.db.gz").path
    assert path == (
        "/my-bucket/tickerglass/my%20file%2B1%20%C3%BC%E6%97%A5%E6%9C%AC/"
        "a~b-c_d.e%24f%26g%3Dh%2Ci%3Bj%27k%28l%29%2Am%21n.db.gz"
    )
    assert s3mod.uri_encode("a/b c", keep_slash=False) == "a%2Fb%20c"


def test_full_key_helper() -> None:
    assert S3Client(cfg()).full_key("x.db.gz") == "tickerglass/x.db.gz"
    assert S3Client(cfg(prefix="tickerglass")).full_key("x") == "tickerglass/x"
    assert S3Client(cfg(prefix="")).full_key("x") == "x"


@pytest.mark.parametrize(
    "over",
    [
        {"endpoint": "ftp://host"},
        {"endpoint": "file:///etc"},
        {"endpoint": "host-only"},
        {"endpoint": "http://user:pw@host"},
        {"endpoint": "http://host?x=1"},
        {"endpoint": "http://host:notaport"},
        {"bucket": ""},
        {"bucket": "a/b"},
    ],
)
def test_invalid_config(over: dict[str, Any]) -> None:
    with pytest.raises(S3Error) as ei:
        S3Client(cfg(**over))
    assert ei.value.code == "invalid_config"


def test_error_str_has_only_code() -> None:
    err = S3Error("AccessDenied", 403)
    assert str(err) == "S3 request failed: AccessDenied"
    assert err.code == "AccessDenied"


# --- fake S3 server -------------------------------------------------------------------------

BUCKET = "bkt"


class FakeS3:
    """Path-style fake that verifies SigV4 (by re-signing) and the payload hash."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, datetime]] = {}
        self.page_size = 2
        self.fail_with: tuple[int, bytes] | None = None
        self.requests: list[tuple[str, str]] = []
        self.hang_up_on_get = False
        self.stamp = datetime(2026, 5, 1, 3, 30, 0, tzinfo=UTC)

    def handler(self) -> type[http.server.BaseHTTPRequestHandler]:
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a: Any) -> None:
                pass

            def _reply(
                self, status: int, body: bytes = b"", ctype: str = "application/xml"
            ) -> None:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _xml_error(self, status: int, code: str) -> None:
                self._reply(
                    status,
                    f"<?xml version='1.0'?><Error><Code>{code}</Code>"
                    f"<Message>detail {AWS_SECRET}</Message></Error>".encode(),
                )

            def _verify(self, body: bytes) -> bool:
                if self.headers.get("Authorization") is None:
                    return False
                raw_path, _, raw_query = self.path.partition("?")
                query = urllib.parse.parse_qsl(raw_query, keep_blank_values=True)
                payload = self.headers["x-amz-content-sha256"]
                if self.command == "PUT" and payload != hashlib.sha256(body).hexdigest():
                    return False
                expected = sign_headers(
                    method=self.command,
                    host=self.headers["Host"],
                    path=raw_path,
                    query=query,
                    headers={},
                    payload_hash=payload,
                    amz_date=self.headers["x-amz-date"],
                    access_key_id=AWS_KEY,
                    secret_access_key=AWS_SECRET,
                    region="us-east-1",
                )
                return self.headers["Authorization"] == expected["Authorization"]

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                fake.requests.append((self.command, self.path))
                if fake.fail_with is not None:
                    status, payload = fake.fail_with
                    self._reply(status, payload)
                    return
                if not self._verify(body):
                    self._xml_error(403, "SignatureDoesNotMatch")
                    return
                raw_path, _, raw_query = self.path.partition("?")
                path = urllib.parse.unquote(raw_path)
                query = dict(urllib.parse.parse_qsl(raw_query, keep_blank_values=True))
                if path == f"/{BUCKET}":
                    if self.command == "HEAD":
                        self._reply(200)
                    elif self.command == "GET":
                        self._list(query)
                    else:
                        self._xml_error(405, "MethodNotAllowed")
                    return
                if not path.startswith(f"/{BUCKET}/"):
                    self._xml_error(404, "NoSuchBucket")
                    return
                key = path[len(BUCKET) + 2 :]
                if self.command == "PUT":
                    fake.objects[key] = (body, fake.stamp)
                    self._reply(200)
                elif self.command == "DELETE":
                    fake.objects.pop(key, None)
                    self._reply(204)
                elif self.command == "GET":
                    if key not in fake.objects:
                        self._xml_error(404, "NoSuchKey")
                    elif fake.hang_up_on_get:
                        data = fake.objects[key][0]
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data) + 100))
                        self.end_headers()
                        self.wfile.write(data)
                        self.close_connection = True
                    else:
                        self._reply(200, fake.objects[key][0], "application/octet-stream")

            def _list(self, query: dict[str, str]) -> None:
                keys = sorted(k for k in fake.objects if k.startswith(query.get("prefix", "")))
                start = int(query["continuation-token"][4:]) if "continuation-token" in query else 0
                page = keys[start : start + fake.page_size]
                more = start + fake.page_size < len(keys)
                items = "".join(
                    f"<Contents><Key>{k.replace('&', '&amp;')}</Key>"
                    f"<LastModified>{fake.objects[k][1].strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
                    f"</LastModified><Size>{len(fake.objects[k][0])}</Size></Contents>"
                    for k in page
                )
                token = (
                    f"<NextContinuationToken>tok-{start + fake.page_size}</NextContinuationToken>"
                )
                xml = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    f"<Name>{BUCKET}</Name><KeyCount>{len(page)}</KeyCount>"
                    f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>"
                    f"{token if more else ''}{items}</ListBucketResult>"
                )
                self._reply(200, xml.encode())

            do_GET = do_PUT = do_DELETE = do_HEAD = _handle  # noqa: N815

        return Handler


@pytest.fixture
def fake() -> Iterator[tuple[FakeS3, S3Client]]:
    state = FakeS3()

    class Quiet(http.server.ThreadingHTTPServer):
        def handle_error(self, request: Any, client_address: Any) -> None:
            pass  # clients that hang up mid-request are part of the scenarios

    server = Quiet(("127.0.0.1", 0), state.handler())
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    port = server.server_address[1]
    client = S3Client(
        cfg(endpoint=f"http://127.0.0.1:{port}", bucket=BUCKET, region="us-east-1"), timeout=5
    )
    try:
        yield state, client
    finally:
        server.shutdown()
        server.server_close()


def put(client: S3Client, key: str, data: bytes) -> None:
    client.put_object(key, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest())


def test_put_get_roundtrip(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    data = bytes(range(256)) * 9000  # > 2 MiB, so several upload and download chunks
    put(client, "tickerglass/tickerglass-20260501T033000Z.db.gz", data)
    assert state.objects["tickerglass/tickerglass-20260501T033000Z.db.gz"][0] == data
    out = io.BytesIO()
    client.get_object("tickerglass/tickerglass-20260501T033000Z.db.gz", out)
    assert out.getvalue() == data


def test_put_empty_and_special_key(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    key = "tickerglass/my file+1 ü日本 & co.json"
    put(client, key, b"")
    assert state.objects[key][0] == b""
    out = io.BytesIO(b"")
    client.get_object(key, out)
    assert out.getvalue() == b""
    assert [o.key for o in client.list_objects("tickerglass/")] == [key]


def test_put_uses_given_hash_and_rejects_mismatch(fake: tuple[FakeS3, S3Client]) -> None:
    _, client = fake
    with pytest.raises(S3Error) as ei:
        client.put_object("k", io.BytesIO(b"abc"), 3, hashlib.sha256(b"other").hexdigest())
    assert ei.value.code == "SignatureDoesNotMatch"
    for bad in ("", "UNSIGNED-PAYLOAD", "A" * 64, "ab"):
        with pytest.raises(S3Error) as ei:
            client.put_object("k", io.BytesIO(b"abc"), 3, bad)
        assert ei.value.code == "invalid_request"


def test_put_short_file_is_an_error(fake: tuple[FakeS3, S3Client]) -> None:
    _, client = fake
    with pytest.raises(S3Error):
        client.put_object("k", io.BytesIO(b"abc"), 10, hashlib.sha256(b"abc").hexdigest())


def test_put_too_large(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    with pytest.raises(S3Error) as ei:
        client.put_object("k", io.BytesIO(b""), 5 * (1 << 30) + 1, "0" * 64)
    assert ei.value.code == "too_large"
    assert state.requests == []  # refused locally


def test_list_with_continuation(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    for i in range(5):
        put(client, f"tickerglass/f{i}.db.gz", b"x" * (i + 1))
    put(client, "other/skip.txt", b"zz")
    state.requests.clear()
    objs = client.list_objects("tickerglass/")
    assert [(o.key, o.size) for o in objs] == [(f"tickerglass/f{i}.db.gz", i + 1) for i in range(5)]
    assert objs[0].last_modified == datetime(2026, 5, 1, 3, 30, tzinfo=UTC)
    assert objs[0].last_modified.tzinfo is not None
    lists = [p for m, p in state.requests if m == "GET"]
    assert len(lists) == 3  # 2 + 2 + 1
    assert "continuation-token" not in lists[0]
    assert all("list-type=2" in p and "prefix=tickerglass%2F" in p for p in lists)
    assert "continuation-token=tok-2" in lists[1]
    assert client.list_objects("nothing/") == []


def test_list_xml_special_characters(fake: tuple[FakeS3, S3Client]) -> None:
    _, client = fake
    put(client, "tickerglass/a&b.db.gz", b"1")
    assert [o.key for o in client.list_objects("tickerglass/")] == ["tickerglass/a&b.db.gz"]


def test_delete_and_head(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    put(client, "tickerglass/a", b"1")
    client.delete_object("tickerglass/a")
    assert "tickerglass/a" not in state.objects
    client.delete_object("tickerglass/a")  # idempotent, like S3
    client.head_bucket()


def test_error_xml_becomes_code_without_secrets(fake: tuple[FakeS3, S3Client]) -> None:
    _, client = fake
    with pytest.raises(S3Error) as ei:
        client.get_object("tickerglass/missing", io.BytesIO())
    err = ei.value
    assert err.code == "NoSuchKey"
    assert err.status == 404
    assert AWS_SECRET not in str(err) and AWS_SECRET not in repr(err)
    assert "detail" not in str(err)


def test_wrong_credentials_report_signature_code(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    bad = S3Client(
        cfg(
            endpoint=client._cfg.endpoint,
            bucket=BUCKET,
            region="us-east-1",
            secret_access_key="definitely-not-the-secret",
        ),
        timeout=5,
    )
    with pytest.raises(S3Error) as ei:
        bad.head_bucket()
    # HEAD carries no body, so only the status is known
    assert ei.value.code == "http_403"
    with pytest.raises(S3Error) as ei:
        bad.list_objects("")
    assert ei.value.code == "SignatureDoesNotMatch"
    for text in (str(ei.value), repr(ei.value)):
        assert "definitely-not-the-secret" not in text
        assert AWS_KEY not in text
    assert state.objects == {}


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (500, b"", "http_500"),
        (503, b"<html>slow down</html>", "http_503"),
        (403, b"<Error><Code>AccessDenied</Code></Error>", "AccessDenied"),
        (404, b"<Error><Code>bad code with spaces</Code></Error>", "http_404"),
        (301, b"<Error><Code>PermanentRedirect</Code></Error>", "PermanentRedirect"),
        (302, b"", "http_302"),  # redirects are never followed
        (307, b"", "http_307"),
        (400, b"<Error><Code></Code></Error>", "http_400"),
    ],
)
def test_error_mapping(fake: tuple[FakeS3, S3Client], status: int, body: bytes, code: str) -> None:
    state, client = fake
    state.fail_with = (status, body)
    with pytest.raises(S3Error) as ei:
        client.list_objects("")
    assert ei.value.code == code
    assert len(state.requests) == 1  # no redirect followed


def test_doctype_and_entities_rejected(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    evil = (
        b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "boom">]>'
        b"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
    )
    state.fail_with = (200, evil)
    with pytest.raises(S3Error) as ei:
        client.list_objects("")
    assert ei.value.code == "bad_response"
    state.fail_with = (200, b"<ListBucketResult><IsTruncated>")
    with pytest.raises(S3Error) as ei:
        client.list_objects("")
    assert ei.value.code == "bad_response"


def test_doctype_rejected_in_error_body(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    state.fail_with = (
        403,
        b'<!DOCTYPE x [<!ENTITY a "b">]><Error><Code>AccessDenied</Code></Error>',
    )
    with pytest.raises(S3Error) as ei:
        client.list_objects("")
    assert ei.value.code == "http_403"


def test_truncated_listing_without_token_is_an_error(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    state.fail_with = (
        200,
        b"<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    )
    with pytest.raises(S3Error) as ei:
        client.list_objects("")
    assert ei.value.code == "bad_response"


def test_short_download_is_an_error(fake: tuple[FakeS3, S3Client]) -> None:
    state, client = fake
    put(client, "tickerglass/a", b"hello world")
    state.hang_up_on_get = True
    with pytest.raises(S3Error) as ei:
        client.get_object("tickerglass/a", io.BytesIO())
    assert ei.value.code == "network"


def test_connection_refused_is_network_error() -> None:
    client = S3Client(cfg(endpoint="http://127.0.0.1:1", bucket=BUCKET), timeout=2)
    with pytest.raises(S3Error) as ei:
        client.head_bucket()
    assert ei.value.code == "network"
    assert "127.0.0.1" not in str(ei.value)
    with pytest.raises(S3Error) as ei:
        put(client, "k", b"data")
    assert ei.value.code == "network"


def test_timeout_is_network_error() -> None:
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)  # accepts at the kernel level but never answers
    try:
        client = S3Client(
            cfg(endpoint=f"http://127.0.0.1:{sock.getsockname()[1]}", bucket=BUCKET), timeout=0.3
        )
        with pytest.raises(S3Error) as ei:
            client.head_bucket()
        assert ei.value.code == "network"
    finally:
        sock.close()
