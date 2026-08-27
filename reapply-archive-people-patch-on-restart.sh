#!/usr/bin/env bash
# Watches for immich_server (re)starting -- including immich-auto-upgrade.service pulling a
# new image -- and re-applies patch_immich_archive_people.py against the fresh container.
#
# The patch lives in the container's compiled JS, not in the image itself, so every restart
# (and every upgrade, which recreates the container from a brand-new unpatched image) loses
# it. This is the same watch-and-react pattern as restart-on-immich-restart.sh, just reacting
# with a re-patch instead of a captioner bounce.
#
# patch_immich_archive_people.py is idempotent and itself issues the one restart needed to
# load a freshly-applied patch; that restart re-triggers this same "start" event, but the
# second pass finds the marker already present and does nothing further, so this does not
# loop.
set -euo pipefail

IMMICH_CONTAINER="${IMMICH_CONTAINER:-immich_server}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SCRIPT="$SCRIPT_DIR/patch_immich_archive_people.py"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

wait_for_healthy() {
    local waited=0
    while (( waited < HEALTH_TIMEOUT_SECONDS )); do
        local status
        status="$(docker inspect -f '{{.State.Health.Status}}' "$IMMICH_CONTAINER" 2>/dev/null || echo "unknown")"
        if [[ "$status" == "healthy" ]]; then
            return 0
        fi
        sleep "$HEALTH_POLL_SECONDS"
        waited=$(( waited + HEALTH_POLL_SECONDS ))
    done
    return 1
}

log "Watching for '$IMMICH_CONTAINER' restarts to re-apply the archive-people patch..."

docker events --filter "container=$IMMICH_CONTAINER" --filter "event=start" --format '{{.Time}}' |
while read -r _; do
    log "$IMMICH_CONTAINER started; waiting for it to report healthy..."
    if wait_for_healthy; then
        log "$IMMICH_CONTAINER healthy; applying archive-people patch"
    else
        log "Timed out waiting for $IMMICH_CONTAINER to become healthy after ${HEALTH_TIMEOUT_SECONDS}s; attempting patch anyway"
    fi
    if python3 "$PATCH_SCRIPT" --container "$IMMICH_CONTAINER"; then
        log "patch check/apply completed successfully"
    else
        log "PATCH FAILED -- see output above. immich_server is running UNPATCHED (People page will undercount archived-only people again). This needs a human to check whether upstream Immich changed the query this patch targets."
    fi
done
