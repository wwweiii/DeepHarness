#!/usr/bin/env bash
set -euo pipefail

# Create a consistent control-plane dump and optional Agent state archives.
# The output directory is explicit so operators can copy it to an encrypted
# backup target without the script guessing a broad filesystem path.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
backup_dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

if ! docker compose ps --status running postgres >/dev/null 2>&1; then
  echo "postgres is not running; start the stack before taking a backup" >&2
  exit 1
fi

docker compose exec -T postgres pg_dump \
  --format=custom --no-owner --no-privileges \
  -U "${POSTGRES_USER:-deepharness}" "${POSTGRES_DB:-deepharness}" \
  > "$backup_dir/control-plane.dump"

docker compose config --hash '*' > "$backup_dir/compose-hashes.txt"
git -C "$repo_root" rev-parse HEAD > "$backup_dir/deepharness-commit.txt"
git -C "$repo_root/vendor/claude-code" rev-parse HEAD > "$backup_dir/vendor-commit.txt"

sha256sum "$backup_dir/control-plane.dump" > "$backup_dir/SHA256SUMS"
printf 'backup_dir=%s\n' "$backup_dir"
