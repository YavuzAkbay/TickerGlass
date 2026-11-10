"""TickerGlass data API."""

import os

from ._version import __version__ as _FILE_VERSION

# Docker images are stamped with the release tag (build arg TICKERGLASS_VERSION ->
# ENV); source checkouts and tests fall back to the file constant.
__version__ = os.environ.get("TICKERGLASS_VERSION") or _FILE_VERSION
