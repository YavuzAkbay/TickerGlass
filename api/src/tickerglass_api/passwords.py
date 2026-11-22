"""Local-account passwords (docs/design/multi-user.md): stdlib scrypt, no new dependency.

Stored as `scrypt$n$r$p$salt_b64$hash_b64` (urlsafe base64, no padding); verified in constant
time. Parameters are read back from the stored value, so they can be raised later without
invalidating old hashes, but values outside a sane range are refused (a tampered hash must not
make the server allocate gigabytes).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32
MIN_LENGTH = 10
MAX_LENGTH = 1024
_MAX_N = 2**17
_MAX_RP = 16


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=length,
        maxmem=256 * n * r + (1 << 20),
    )


def check_strength(password: str) -> None:
    """Raises ValueError for a password that may not be set."""
    if len(password) < MIN_LENGTH:
        raise ValueError(f"password must be at least {MIN_LENGTH} characters")
    if len(password) > MAX_LENGTH:
        raise ValueError(f"password must be at most {MAX_LENGTH} characters")


def hash_password(password: str) -> str:
    check_strength(password)
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_BYTES)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(stored: str | None, password: str) -> bool:
    """True if `password` matches `stored`. Anything malformed (or no stored hash) is False,
    after the same amount of work as a real check where that is cheap to arrange."""
    if not stored or len(password) > MAX_LENGTH:
        return False
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, expected = _unb64(parts[4]), _unb64(parts[5])
    except (ValueError, binascii.Error):
        return False
    if not (2 <= n <= _MAX_N and n & (n - 1) == 0 and 1 <= r <= _MAX_RP and 1 <= p <= _MAX_RP):
        return False
    if not (8 <= len(salt) <= 64 and 16 <= len(expected) <= 128):
        return False
    try:
        actual = _scrypt(password, salt, n, r, p, len(expected))
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(actual, expected)


_DUMMY: str | None = None


def burn_verify(password: str) -> None:
    """Spend the time of a real verification (unknown username, no local password), so the
    response time does not tell which usernames exist."""
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = hash_password(secrets.token_urlsafe(16))
    verify_password(_DUMMY, password)
