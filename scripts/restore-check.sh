#!/usr/bin/env bash
set -euo pipefail

# Validate a backup without touching the active database. This is deliberately
# a restore rehearsal in an isolated Compose project and never runs `down -v`.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
backup_dir="${1:-}"
if [[ -z "$backup_dir" || ! -f "$backup_dir/control-plane.dump" ]]; then
  echo "usage: $0 BACKUP_DIR" >&2
  exit 2
fi

project="deepharness-restore-$(date +%s)"
cleanup() {
  docker compose -p "$project" -f compose.yaml down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "$project" -f compose.yaml up -d postgres
until docker compose -p "$project" -f compose.yaml exec -T postgres pg_isready -U "${POSTGRES_USER:-deepharness}" -d "${POSTGRES_DB:-deepharness}" >/dev/null 2>&1; do
  sleep 1
done
docker compose -p "$project" -f compose.yaml exec -T postgres pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U "${POSTGRES_USER:-deepharness}" -d "${POSTGRES_DB:-deepharness}" \
  < "$backup_dir/control-plane.dump"
docker compose -p "$project" -f compose.yaml exec -T postgres \
  psql -U "${POSTGRES_USER:-deepharness}" -d "${POSTGRES_DB:-deepharness}" \
  -c "SELECT count(*) AS restored_tables FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
printf 'restore_check=passed\n'
