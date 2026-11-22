"""Chunked AES-256-GCM for backup files (format `TGBK1`).

Layout::

    header = MAGIC (6) | scrypt n, r, p (3 x uint32 BE) | salt (16) | nonce prefix (8)
    body   = frame*     frame = uint32 BE length | AES-GCM ciphertext (plaintext chunk + 16 tag)

Every chunk is up to 1 MiB of plaintext, sealed with nonce `prefix || uint32 counter` and
AAD `header || uint32 counter || final flag`. The last chunk carries final flag 1 (an empty
plaintext still produces one final chunk), so truncation, reordering, dropped chunks and trailing
data all fail authentication. The key is `scrypt(passphrase, salt)`.

Both directions stream: at most two chunks are held in memory. `decrypt_stream` writes each
plaintext chunk once it authenticates, so on `BackupCryptoError` the destination holds a
(possibly empty) prefix of the plaintext and the caller must discard it.
"""

import os
import struct
from typing import BinaryIO

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"TGBK1\0"
MIN_PASSPHRASE = 12

CHUNK_SIZE = 1 << 20
SCRYPT_N = 1 << 15
SCRYPT_R = 8
SCRYPT_P = 1
SALT_LEN = 16
NONCE_PREFIX_LEN = 8
TAG_LEN = 16

MAX_N = 1 << 20
MAX_R = 32
MAX_P = 16
MAX_SCRYPT_MEM = 1 << 30  # 128 * n * r bytes; refuses pathological headers that fit the bounds

_PARAMS = struct.Struct(">III")
_U32 = struct.Struct(">I")
_HEADER_LEN = len(MAGIC) + _PARAMS.size + SALT_LEN + NONCE_PREFIX_LEN
_MAX_COUNTER = 0xFFFFFFFF

_BAD_FORMAT = "not a valid encrypted backup"
_BAD_DATA = "wrong passphrase or corrupted backup"


class BackupCryptoError(Exception):
    """Encryption or decryption failed; the message is deliberately generic."""


def is_encrypted(head: bytes) -> bool:
    """True when `head` (the first bytes of a file) starts with the backup magic."""
    return head.startswith(MAGIC)


def _derive_key(passphrase: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    try:
        secret = passphrase.encode("utf-8")
        return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(secret)
    except (ValueError, MemoryError, UnicodeEncodeError):
        raise BackupCryptoError("key derivation failed") from None


def _read_full(src: BinaryIO, size: int) -> bytes:
    """Read up to `size` bytes, looping over short reads; shorter only at EOF."""
    parts: list[bytes] = []
    remaining = size
    while remaining > 0:
        part = src.read(remaining)
        if not part:
            break
        parts.append(part)
        remaining -= len(part)
    return parts[0] if len(parts) == 1 else b"".join(parts)


def _nonce(prefix: bytes, counter: int) -> bytes:
    return prefix + _U32.pack(counter)


def _aad(header: bytes, counter: int, final: bool) -> bytes:
    return header + _U32.pack(counter) + (b"\x01" if final else b"\x00")


def encrypt_stream(src: BinaryIO, dst: BinaryIO, passphrase: str) -> None:
    """Encrypt everything in `src` into `dst`. Needs a passphrase of `MIN_PASSPHRASE`+ chars."""
    if len(passphrase) < MIN_PASSPHRASE:
        raise BackupCryptoError(f"passphrase must be at least {MIN_PASSPHRASE} characters")
    salt = os.urandom(SALT_LEN)
    nonce_prefix = os.urandom(NONCE_PREFIX_LEN)
    header = MAGIC + _PARAMS.pack(SCRYPT_N, SCRYPT_R, SCRYPT_P) + salt + nonce_prefix
    aead = AESGCM(_derive_key(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P))
    dst.write(header)

    counter = 0
    current = _read_full(src, CHUNK_SIZE)
    while True:
        # One chunk of lookahead tells whether `current` is the last one.
        upcoming = _read_full(src, CHUNK_SIZE) if len(current) == CHUNK_SIZE else b""
        final = not upcoming
        sealed = aead.encrypt(_nonce(nonce_prefix, counter), current, _aad(header, counter, final))
        dst.write(_U32.pack(len(sealed)))
        dst.write(sealed)
        if final:
            return
        if counter >= _MAX_COUNTER:
            raise BackupCryptoError("input too large")
        counter += 1
        current = upcoming


def _read_header(src: BinaryIO) -> tuple[bytes, int, int, int, bytes, bytes]:
    header = _read_full(src, _HEADER_LEN)
    if len(header) != _HEADER_LEN or not is_encrypted(header):
        raise BackupCryptoError(_BAD_FORMAT)
    offset = len(MAGIC)
    n, r, p = _PARAMS.unpack_from(header, offset)
    offset += _PARAMS.size
    salt = header[offset : offset + SALT_LEN]
    nonce_prefix = header[offset + SALT_LEN :]
    n_ok = n >= 2 and n & (n - 1) == 0 and n <= MAX_N
    if not (n_ok and 1 <= r <= MAX_R and 1 <= p <= MAX_P and 128 * n * r <= MAX_SCRYPT_MEM):
        raise BackupCryptoError(_BAD_FORMAT)
    return header, n, r, p, salt, nonce_prefix


def _read_frame(src: BinaryIO) -> bytes | None:
    """The next ciphertext frame, or None on a clean end of stream."""
    prefix = _read_full(src, _U32.size)
    if not prefix:
        return None
    if len(prefix) != _U32.size:
        raise BackupCryptoError(_BAD_DATA)
    (length,) = _U32.unpack(prefix)
    if not TAG_LEN <= length <= CHUNK_SIZE + TAG_LEN:
        raise BackupCryptoError(_BAD_DATA)
    sealed = _read_full(src, length)
    if len(sealed) != length:
        raise BackupCryptoError(_BAD_DATA)
    return sealed


def decrypt_stream(src: BinaryIO, dst: BinaryIO, passphrase: str) -> None:
    """Decrypt `src` into `dst`; see the module docstring for the partial-output caveat."""
    header, n, r, p, salt, nonce_prefix = _read_header(src)
    aead = AESGCM(_derive_key(passphrase, salt, n, r, p))

    counter = 0
    current = _read_frame(src)
    if current is None:
        raise BackupCryptoError(_BAD_DATA)
    while True:
        upcoming = _read_frame(src)
        final = upcoming is None
        try:
            plain = aead.decrypt(
                _nonce(nonce_prefix, counter), current, _aad(header, counter, final)
            )
        except InvalidTag:
            raise BackupCryptoError(_BAD_DATA) from None
        dst.write(plain)
        if upcoming is None:
            return
        if counter >= _MAX_COUNTER:
            raise BackupCryptoError(_BAD_DATA)
        counter += 1
        current = upcoming
