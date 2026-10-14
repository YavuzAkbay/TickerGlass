"""Shared fixtures: the user-data `client` / `race_client` (defined in test_userdata) and
the alerts `make_client` factory (defined in test_alerts)."""

from test_alerts import make_client  # noqa: F401
from test_userdata import client, race_client  # noqa: F401
