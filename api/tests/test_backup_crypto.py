import io
import os
import struct

import pytest

from tickerglass_api.backups import crypto
from tickerglass_api.backups.crypto import (
    MAGIC,
    MIN_PASSPHRASE,
    BackupCryptoError,
    decrypt_stream,
    encrypt_stream,
    is_encrypted,
)

PASS = "correct horse battery"
MIB = 1 << 20


@pytest.fixture
def fast_kdf(monkeypatch: pytest.MonkeyPatch) -> None:
    """Cheap scrypt cost so the many round trips stay quick (production params: see below)."""
    monkeypatch.setattr(crypto, "SCRYPT_N", 1 << 10)


def enc(data: bytes, passphrase: str = PASS) -> bytes:
    out = io.BytesIO()
    encrypt_stream(io.BytesIO(data), out, passphrase)
    return out.getvalue()


def dec(blob: bytes, passphrase: str = PASS) -> bytes:
    out = io.BytesIO()
    decrypt_stream(io.BytesIO(blob), out, passphrase)
    return out.getvalue()


def split(blob: bytes) -> tuple[bytes, list[bytes]]:
    """(header, [frame = length prefix + ciphertext, ...])."""
    header, rest = blob[: crypto._HEADER_LEN], blob[crypto._HEADER_LEN :]
    frames = []
    while rest:
        (n,) = struct.unpack(">I", rest[:4])
        frames.append(rest[: 4 + n])
        rest = rest[4 + n :]
    return header, frames


def small_chunks(monkeypatch: pytest.MonkeyPatch, size: int = 100) -> None:
    monkeypatch.setattr(crypto, "CHUNK_SIZE", size)


@pytest.mark.parametrize("size", [0, 1, MIB, MIB + 1, 3 * MIB + MIB // 2])
def test_roundtrip(fast_kdf: None, size: int) -> None:
    data = os.urandom(size)
    blob = enc(data)
    assert is_encrypted(blob[:16])
    assert dec(blob) == data


def test_chunk_count_matches_size(fast_kdf: None) -> None:
    assert len(split(enc(b""))[1]) == 1  # empty plaintext still yields one (final) chunk
    assert len(split(enc(b"x" * MIB))[1]) == 1  # exact multiple: no trailing empty chunk
    assert len(split(enc(b"x" * (3 * MIB + MIB // 2)))[1]) == 4


def test_production_params_in_header_and_roundtrip() -> None:
    blob = enc(b"hello")
    assert blob.startswith(MAGIC)
    n, r, p = struct.unpack(">III", blob[len(MAGIC) : len(MAGIC) + 12])
    assert (n, r, p) == (2**15, 8, 1)
    assert dec(blob) == b"hello"


def test_output_is_randomised(fast_kdf: None) -> None:
    assert enc(b"same") != enc(b"same")


def test_is_encrypted() -> None:
    assert is_encrypted(MAGIC + b"rest")
    assert not is_encrypted(b"\x1f\x8b\x08")
    assert not is_encrypted(b"")
    assert not is_encrypted(MAGIC[:-1])


def test_short_passphrase_refused_on_encrypt() -> None:
    assert MIN_PASSPHRASE == 12
    with pytest.raises(BackupCryptoError):
        enc(b"x", "x" * (MIN_PASSPHRASE - 1))


def test_unicode_passphrase(fast_kdf: None) -> None:
    phrase = "pässwörd-日本語-🔑-long"
    assert dec(enc(b"data", phrase), phrase) == b"data"


def test_wrong_passphrase(fast_kdf: None) -> None:
    blob = enc(b"secret" * 1000)
    with pytest.raises(BackupCryptoError) as ei:
        dec(blob, "not the passphrase")
    assert "secret" not in str(ei.value)
    with pytest.raises(BackupCryptoError):
        dec(blob, "")


def test_error_does_not_leak_partial_state_message(fast_kdf: None) -> None:
    blob = bytearray(enc(b"abc"))
    blob[-1] ^= 1
    with pytest.raises(BackupCryptoError, match="wrong passphrase or corrupted backup"):
        dec(bytes(blob))


def test_flipped_byte_in_every_region(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    blob = enc(os.urandom(250))  # three chunks
    header, frames = split(blob)
    assert len(frames) == 3
    offsets = {
        "magic": 0,
        "n": len(MAGIC),
        "r": len(MAGIC) + 4,
        "p": len(MAGIC) + 8,
        "salt": len(MAGIC) + 12 + 3,
        "nonce_prefix": crypto._HEADER_LEN - 2,
    }
    pos = len(header)
    for i, frame in enumerate(frames):
        offsets[f"len{i}"] = pos + 3
        offsets[f"ct{i}_first"] = pos + 4
        offsets[f"ct{i}_tag"] = pos + len(frame) - 1
        pos += len(frame)
    for offset in offsets.values():
        bad = bytearray(blob)
        bad[offset] ^= 0x01
        with pytest.raises(BackupCryptoError):
            dec(bytes(bad))


def test_truncated(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    blob = enc(os.urandom(250))
    _, frames = split(blob)
    for cut in (1, 5, len(frames[-1]) - 1, len(frames[-1]), len(frames[-1]) + 2):
        with pytest.raises(BackupCryptoError):
            dec(blob[:-cut])
    with pytest.raises(BackupCryptoError):
        dec(blob[: crypto._HEADER_LEN])  # header only, no chunks
    with pytest.raises(BackupCryptoError):
        dec(blob[: crypto._HEADER_LEN - 1])
    with pytest.raises(BackupCryptoError):
        dec(b"")


def test_dropped_chunk(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    header, frames = split(enc(os.urandom(250)))
    for drop in range(3):
        kept = [f for i, f in enumerate(frames) if i != drop]
        with pytest.raises(BackupCryptoError):
            dec(header + b"".join(kept))


def test_swapped_chunks(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    header, frames = split(enc(os.urandom(250)))
    for a, b in ((0, 1), (1, 2), (0, 2)):
        swapped = list(frames)
        swapped[a], swapped[b] = swapped[b], swapped[a]
        with pytest.raises(BackupCryptoError):
            dec(header + b"".join(swapped))


def test_duplicated_chunk(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    header, frames = split(enc(os.urandom(250)))
    with pytest.raises(BackupCryptoError):
        dec(header + frames[0] + frames[0] + frames[1] + frames[2])


def test_appended_bytes(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    blob = enc(os.urandom(250))
    _, frames = split(blob)
    for extra in (
        b"\x00",
        b"\x00\x00\x00\x00",
        os.urandom(40),
        frames[-1],
        b"\x00\x00\x00\x10" + b"a" * 16,
    ):
        with pytest.raises(BackupCryptoError):
            dec(blob + extra)


def test_final_chunk_cannot_be_replayed_as_inner(
    fast_kdf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    small_chunks(monkeypatch)
    header, frames = split(enc(os.urandom(250)))
    with pytest.raises(BackupCryptoError):
        dec(header + frames[0] + frames[1] + frames[2] + frames[2])


def test_swapped_between_two_backups_fails(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)
    h1, f1 = split(enc(os.urandom(250)))
    _, f2 = split(enc(os.urandom(250)))
    with pytest.raises(BackupCryptoError):
        dec(h1 + f1[0] + f2[1] + f1[2])


def _header(n: int, r: int, p: int, magic: bytes = MAGIC) -> bytes:
    return magic + struct.pack(">III", n, r, p) + b"\x00" * 16 + b"\x00" * 8


@pytest.mark.parametrize(
    ("n", "r", "p"),
    [
        (0, 8, 1),
        (1, 8, 1),
        (3, 8, 1),  # not a power of two
        (2**15 + 1, 8, 1),
        (2**21, 8, 1),  # above the cap
        (2**15, 0, 1),
        (2**15, 33, 1),
        (2**15, 8, 0),
        (2**15, 8, 17),
        (2**20, 32, 1),  # inside the individual bounds but needs 4 GiB
        (2**32 - 1, 8, 1),
    ],
)
def test_bad_header_params(n: int, r: int, p: int) -> None:
    body = struct.pack(">I", 16) + b"\x00" * 16
    with pytest.raises(BackupCryptoError, match="not a valid encrypted backup"):
        dec(_header(n, r, p) + body)


def test_unknown_version_and_garbage() -> None:
    with pytest.raises(BackupCryptoError):
        dec(_header(2**15, 8, 1, magic=b"TGBK2\0"))
    with pytest.raises(BackupCryptoError):
        dec(b"\x1f\x8b" + os.urandom(100))


def test_oversized_frame_length_rejected_before_reading(fast_kdf: None) -> None:
    header = enc(b"x")[: crypto._HEADER_LEN]
    with pytest.raises(BackupCryptoError):
        dec(header + struct.pack(">I", 0xFFFFFFFF) + b"x" * 32)
    with pytest.raises(BackupCryptoError):
        dec(header + struct.pack(">I", 3) + b"xxx")  # shorter than a GCM tag


def test_streaming_holds_at_most_two_chunks(
    fast_kdf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reads are bounded by the chunk size, however large the input."""
    small_chunks(monkeypatch, 64)
    max_read = 0

    class Spy(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            nonlocal max_read
            max_read = max(max_read, size if size is not None and size >= 0 else 1 << 30)
            return super().read(size)

    data = os.urandom(64 * 50 + 7)
    out = io.BytesIO()
    encrypt_stream(Spy(data), out, PASS)
    assert max_read <= 64
    max_read = 0
    plain = io.BytesIO()
    decrypt_stream(Spy(out.getvalue()), plain, PASS)
    assert plain.getvalue() == data
    assert max_read <= 64 + 16


def test_handles_short_reads(fast_kdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    small_chunks(monkeypatch)

    class Trickle(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            return super().read(min(size if size is not None and size >= 0 else 7, 7))

    data = os.urandom(333)
    out = io.BytesIO()
    encrypt_stream(Trickle(data), out, PASS)
    plain = io.BytesIO()
    decrypt_stream(Trickle(out.getvalue()), plain, PASS)
    assert plain.getvalue() == data
