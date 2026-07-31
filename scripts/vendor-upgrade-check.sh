#!/usr/bin/env bash
set -euo pipefail

# Run the immutable vendor upgrade rehearsal. The script never edits the
# submodule; a caller changes the pointer in a reviewable commit and reruns it.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
if [[ -n "$(git -C vendor/claude-code status --porcelain)" ]]; then
  echo "vendor/claude-code has local modifications; refusing an upgrade audit" >&2
  exit 1
fi
vendor_commit="$(git -C vendor/claude-code rev-parse HEAD)"
printf 'vendor_commit=%s\n' "$vendor_commit"
docker compose -f compose.yaml -f compose.test.yaml --profile audit run --rm capability-audit bun run \
  packages/vendor-capabilities/src/cli.ts audit \
  --previous artifacts/capabilities/vendor-capability-manifest.json \
  --artifacts artifacts/capabilities/rehearsal
docker compose -f compose.yaml -f compose.test.yaml --profile audit run --rm capability-audit bun run \
  packages/vendor-capabilities/src/cli.ts gate \
  --manifest artifacts/capabilities/rehearsal/vendor-capability-manifest.json \
  --diff artifacts/capabilities/rehearsal/vendor-capability-diff.json
cp artifacts/capabilities/rehearsal/vendor-capability-diff.json \
  artifacts/capabilities/vendor-capability-diff-rehearsal.json
printf 'upgrade_check=passed\n'
