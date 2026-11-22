#!/bin/sh
# All-in-one entrypoint (PID 1 is tini, which runs this script). Starts the API, the alerts
# service and nginx as the unprivileged PUID:PGID user and supervises them: when any of them
# exits, the others are stopped and the container exits non-zero (the Docker restart policy
# brings it back). SIGTERM/SIGINT stop everything and exit 0.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR=/data
TOKEN_FILE="$DATA_DIR/.alerts_token"
RUN_DIR=/tmp/tickerglass-nginx
STOP_TIMEOUT_S=8 # docker stop waits 10 s before SIGKILL

log() { printf 'tickerglass-aio: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

case "$PUID" in '' | *[!0-9]*) die "PUID must be a number, got '$PUID'" ;; esac
case "$PGID" in '' | *[!0-9]*) die "PGID must be a number, got '$PGID'" ;; esac
if [ "$PUID" -eq 0 ]; then
    [ "${ALLOW_ROOT:-}" = true ] ||
        die "PUID=0 would run the API, the alerts service and nginx as root; set PUID/PGID to an unprivileged user (or ALLOW_ROOT=true to allow root anyway)"
    log "WARNING: ALLOW_ROOT=true, everything runs as root"
fi

# Run "$@" as PUID:PGID (numeric ids, no passwd entry needed); never gains privileges back.
as_user() {
    setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs "$@"
}

# nginx is the API's only peer inside the container (the API listens on loopback).
export TRUSTED_PROXIES="${TRUSTED_PROXIES:-127.0.0.1}"

# Fixed internal layout: the health check, the nginx template and the alerts service rely on it.
export TG_LISTEN_PORT=8080
export TG_API_UPSTREAM=127.0.0.1:8000
export API_HOST=127.0.0.1
export API_PORT=8000
export API_URL=http://127.0.0.1:8000

# --- data directory ownership ---------------------------------------------------------------
mkdir -p "$DATA_DIR"
if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ]; then
    log "taking ownership of $DATA_DIR for $PUID:$PGID"
    # The volume is writable by PUID: never follow a link planted in it (chown -h acts on the
    # link itself, find does not descend into links or other filesystems).
    find "$DATA_DIR" -xdev -exec chown -h "$PUID:$PGID" {} + || die "cannot chown $DATA_DIR"
fi

# --- alerts token ---------------------------------------------------------------------------
# The alerts service authenticates to the API with it. Not set: generate once, keep in /data.
# /data is writable by PUID, so root never opens the file (a link planted there could point at
# anything): it is read and created as PUID:PGID, and a link or a non-regular file stops the start.
if [ -z "${ALERTS_INTERNAL_TOKEN:-}" ]; then
    if [ -L "$TOKEN_FILE" ] || { [ -e "$TOKEN_FILE" ] && [ ! -f "$TOKEN_FILE" ]; }; then
        die "$TOKEN_FILE is a symlink or not a regular file: remove it (or set ALERTS_INTERNAL_TOKEN)"
    fi
    # noclobber (`set -C`) makes the create O_EXCL: it fails on an existing file or link.
    # shellcheck disable=SC2016 # the script is meant for the inner shell
    ALERTS_INTERNAL_TOKEN="$(as_user sh -c '
        f=$1
        umask 077
        if [ -f "$f" ] && [ ! -L "$f" ] && [ ! -s "$f" ]; then rm -f "$f"; fi
        if [ ! -e "$f" ] && [ ! -L "$f" ]; then
            (set -C; head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > "$f") || exit 1
        fi
        [ -f "$f" ] && [ ! -L "$f" ] || exit 1
        chmod 600 "$f" && cat "$f"
    ' sh "$TOKEN_FILE")" || die "cannot create or read $TOKEN_FILE"
    [ -n "$ALERTS_INTERNAL_TOKEN" ] || die "$TOKEN_FILE is empty"
fi
export ALERTS_INTERNAL_TOKEN

# --- nginx config ---------------------------------------------------------------------------
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/conf.d"
envsubst '${TG_API_UPSTREAM} ${TG_LISTEN_PORT}' \
    < /etc/tickerglass/nginx.conf.template > "$RUN_DIR/conf.d/default.conf" ||
    die "cannot render the nginx config"
chown -hR "$PUID:$PGID" "$RUN_DIR"

# --- processes ------------------------------------------------------------------------------
API_PID=''
ALERTS_PID=''
NGINX_PID=''
STOPPING=0

# Run "$@" as PUID:PGID (numeric ids, no passwd entry needed), detached; sets STARTED_PID.
start() {
    HOME=/tmp as_user "$@" &
    STARTED_PID=$!
}

alive() { # a zombie (exited, not yet waited for) counts as dead
    [ -r "/proc/$1/stat" ] || return 1
    state="$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null)"
    [ "${state%"${state#?}"}" != Z ] && [ -n "$state" ]
}

nap() { # interruptible by a trapped signal, unlike a plain `sleep`
    sleep "$1" &
    wait $! 2>/dev/null || true
}

on_signal() { STOPPING=1; }
trap on_signal TERM INT

stop_all() { # TERM everything still running, then KILL what ignores it
    for pid in $NGINX_PID $ALERTS_PID $API_PID; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    waited=0
    while [ "$waited" -lt $((STOP_TIMEOUT_S * 4)) ]; do
        running=0
        for pid in $NGINX_PID $ALERTS_PID $API_PID; do
            if alive "$pid"; then running=1; fi
        done
        [ "$running" -eq 0 ] && break
        sleep 0.25
        waited=$((waited + 1))
    done
    for pid in $NGINX_PID $ALERTS_PID $API_PID; do
        if alive "$pid"; then
            log "pid $pid ignored SIGTERM, killing"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
}

finish() { # finish <exit code>
    stop_all
    exit "$1"
}

log "starting the API"
cd /app # root-owned: the API (pydantic) reads ./.env from its working directory
start tickerglass-api
API_PID=$STARTED_PID

waited=0
until python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)" 2>/dev/null; do
    [ "$STOPPING" -eq 1 ] && finish 0
    alive "$API_PID" || { wait "$API_PID" 2>/dev/null || true; log "the API exited during startup"; finish 1; }
    waited=$((waited + 1))
    [ "$waited" -le 60 ] || { log "the API did not become healthy within 60 s"; finish 1; }
    nap 1
done

log "starting the alerts service"
cd /app/alerts
start node --no-node-snapshot dist/index.js
ALERTS_PID=$STARTED_PID

log "starting nginx on :$TG_LISTEN_PORT"
start nginx -e stderr -c /etc/tickerglass/nginx-aio.conf -g 'daemon off;'
NGINX_PID=$STARTED_PID

while [ "$STOPPING" -eq 0 ]; do
    for entry in "api:$API_PID" "alerts:$ALERTS_PID" "nginx:$NGINX_PID"; do
        name="${entry%%:*}"
        pid="${entry#*:}"
        if ! alive "$pid"; then
            code=0
            wait "$pid" 2>/dev/null || code=$?
            [ "$STOPPING" -eq 1 ] && finish 0
            [ "$code" -ne 0 ] || code=1
            log "$name exited ($code), stopping the container"
            finish "$code"
        fi
    done
    nap 1
done

log "stopping"
finish 0
