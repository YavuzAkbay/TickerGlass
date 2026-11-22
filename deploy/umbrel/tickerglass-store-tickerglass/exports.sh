#!/usr/bin/env bash
# Sourced by Umbrel before it reads docker-compose.yml. derive_entropy (Umbrel's helper) returns 64
# hex characters, stable per Umbrel install and per identifier; each secret gets its own identifier
# so that one never reveals the other. Checked by deploy/check.py.
# shellcheck disable=SC2154 # app_entropy_identifier is set by Umbrel's app script
export APP_TICKERGLASS_AUTH_SECRET
APP_TICKERGLASS_AUTH_SECRET="$(derive_entropy "${app_entropy_identifier}-auth-secret")"
export APP_TICKERGLASS_ALERTS_TOKEN
APP_TICKERGLASS_ALERTS_TOKEN="$(derive_entropy "${app_entropy_identifier}-alerts-token")"
