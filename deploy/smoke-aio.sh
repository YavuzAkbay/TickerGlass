#!/usr/bin/env bash
# Smoke test of the all-in-one image: start it on a temp volume, wait until Docker reports it
# healthy, call /api/health, then wait (<= 90 s) until the alerts service has sent its heartbeat
# (GET /api/server/status -> alertsService.online; open mode = owner admin). Checks the owner of
# the data files and the generated alerts token; then checks that a symlinked alerts token stops the
# start without touching its target, and that `docker stop` exits 0 within 15 s.
#
#   deploy/smoke-aio.sh <image> [PUID PGID]
#
# Example: docker build -f docker/aio.Dockerfile -t tickerglass:smoke . && deploy/smoke-aio.sh tickerglass:smoke 99 100
set -euo pipefail

image="${1:?usage: smoke-aio.sh <image> [PUID PGID]}"
puid="${2:-1000}"
pgid="${3:-1000}"
port="${SMOKE_PORT:-18080}"
name="tg-smoke-${puid}-${pgid}-$$"
data="$(mktemp -d)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "$name" 2>&1 | tail -n 80 || true
    docker logs "$name-link" 2>&1 | tail -n 20 || true
  fi
  docker rm -f "$name" "$name-link" >/dev/null 2>&1 || true
  docker volume rm -f "$link_data" "$link_victim" >/dev/null 2>&1 || true
  rm -rf "$data" 2>/dev/null || docker run --rm -v "$data:/d" alpine sh -c 'rm -rf /d/* /d/.[!.]*' || true
  rmdir "$data" 2>/dev/null || true
  exit "$status"
}
link_data="$name-link-data" # named volumes: no dependency on which host paths the Docker VM shares
link_victim="$name-link-victim"
trap cleanup EXIT

echo "== $image with PUID=$puid PGID=$pgid"
# SMOKE_DOCKER_ARGS: extra `docker run` flags, e.g. `-e OPENSSL_armcap=0` on arm64 VMs whose
# CPU flags make OpenSSL crash with "Illegal instruction" (seen under colima; not on CI runners).
# shellcheck disable=SC2086
docker run -d --name "$name" --memory 1536m ${SMOKE_DOCKER_ARGS:-} \
  -e PUID="$puid" -e PGID="$pgid" -e MARKET_PROVIDER=demo \
  -p "127.0.0.1:$port:8080" -v "$data:/data" "$image" >/dev/null

echo "waiting for the container to become healthy (<= 120 s)"
for _ in $(seq 1 120); do
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")"
  case "$state" in
    "running healthy") break ;;
    "exited"* | "dead"*) echo "container stopped: $state"; exit 1 ;;
  esac
  sleep 1
done
[ "$state" = "running healthy" ] || { echo "not healthy: $state"; exit 1; }

curl -fsS "http://127.0.0.1:$port/api/health"
echo
curl -fsS "http://127.0.0.1:$port/" >/dev/null && echo "web index served"

echo "waiting for the alerts heartbeat (<= 90 s)"
online=false
for _ in $(seq 1 90); do
  if [ "$(curl -fsS "http://127.0.0.1:$port/api/server/status" | jq -r '.alertsService.online')" = "true" ]; then
    online=true
    break
  fi
  sleep 1
done
[ "$online" = "true" ] || { echo "alerts service never came online"; exit 1; }
echo "alerts service online"

owner="$(docker exec "$name" stat -c '%u:%g' /data/tickerglass.db)"
[ "$owner" = "$puid:$pgid" ] || { echo "/data/tickerglass.db owned by $owner, expected $puid:$pgid"; exit 1; }
docker exec "$name" test -s /data/.alerts_token || { echo "/data/.alerts_token missing"; exit 1; }
echo "ok: data owned by $owner, alerts token generated"

# --- regression: a symlink planted at /data/.alerts_token ---------------------------------------
# /data is writable by PUID, so the volume owner can plant a link. The entrypoint runs as root: it
# must neither chown nor read through the link (here to a file in a second volume, mounted at
# /victim) and must refuse to start.
echo "== symlinked alerts token must stop the start and leave its target alone"
# shellcheck disable=SC2086
docker run --rm --entrypoint sh ${SMOKE_DOCKER_ARGS:-} -v "$link_data:/data" -v "$link_victim:/victim" "$image" -c \
  "printf untouched > /victim/target && chmod 644 /victim/target && ln -s /victim/target /data/.alerts_token"
stat_victim() { # owner, mode, size, mtime, content
  # shellcheck disable=SC2086
  docker run --rm --entrypoint sh ${SMOKE_DOCKER_ARGS:-} -v "$link_victim:/victim" "$image" -c \
    "stat -c '%u:%g:%a:%s:%Y' /victim/target && cat /victim/target"
}
victim_before="$(stat_victim)"
# An id that owns nothing: if the chown followed the link the target's owner would become it.
# shellcheck disable=SC2086
docker run -d --name "$name-link" ${SMOKE_DOCKER_ARGS:-} -e PUID=4242 -e PGID=4242 -e MARKET_PROVIDER=demo \
  -v "$link_data:/data" -v "$link_victim:/victim" "$image" >/dev/null
link_state=''
for _ in $(seq 1 30); do
  link_state="$(docker inspect --format '{{.State.Status}}' "$name-link")"
  [ "$link_state" = "running" ] || break
  sleep 1
done
[ "$link_state" = "exited" ] || { echo "container did not stop (state: $link_state): it started with a symlinked token"; exit 1; }
link_code="$(docker inspect --format '{{.State.ExitCode}}' "$name-link")"
[ "$link_code" -ne 0 ] || { echo "container exited 0 with a symlinked token"; exit 1; }
victim_after="$(stat_victim)"
[ "$victim_after" = "$victim_before" ] || { echo "symlink target was modified: $victim_before -> $victim_after"; exit 1; }
case "$victim_after" in *untouched) ;; *) echo "symlink target content changed"; exit 1 ;; esac
echo "ok: exited $link_code, target untouched ($(printf '%s' "$victim_after" | head -n 1))"

# --- docker stop: SIGTERM stops all three processes and the container exits 0 well before the
# 10 s SIGKILL grace period.
echo "== docker stop"
stop_start=$SECONDS
docker stop "$name" >/dev/null
stop_took=$((SECONDS - stop_start))
stop_code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
[ "$stop_code" = "0" ] || { echo "docker stop: exit code $stop_code, expected 0"; exit 1; }
[ "$stop_took" -le 15 ] || { echo "docker stop took ${stop_took}s, expected <= 15 s"; exit 1; }
echo "ok: stopped in ${stop_took}s, exit 0"
