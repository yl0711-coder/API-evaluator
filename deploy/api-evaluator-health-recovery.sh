#!/bin/sh
# Run only from the root-owned systemd unit. The fixed name deliberately prevents
# user-provided input from selecting a different Docker object.
set -eu

container_name="api-evaluator"
health_status="$(/usr/bin/docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null || true)"

[ "$health_status" = "unhealthy" ] || exit 0
exec /usr/bin/docker restart --time 30 "$container_name"
