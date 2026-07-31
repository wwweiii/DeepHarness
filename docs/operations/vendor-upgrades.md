# Vendor Upgrades

1. Create a branch and change only the `vendor/claude-code` submodule pointer and related lock metadata.
2. Run `make backup` and save the backup metadata with the proposed image tag.
3. Build the audit image and run `make audit`; the static probe, ACP stdio probe, Harness evidence, manifest, and diff are generated together.
4. Run `make capability-gate`, inspect the diff, and add a narrowly scoped entry to `approved_regressions` only when a human has accepted the downgrade and supplied a reason.
5. Run the full Compose contract/integration/E2E suite and the mobile/desktop visual checks. Repeat the audit on the same pointer to verify a stable diff.
6. Publish an immutable image tag containing the DeepHarness commit and vendor commit. Keep the prior tag available until restore rehearsal passes.

`scripts/vendor-upgrade-check.sh` performs the non-mutating rehearsal. It refuses a dirty vendor worktree and never runs `git pull` inside a Docker build. Rollback is a deployment operation: select the prior image tag and prior submodule pointer, then re-run the health and restore checks. Vendor business code remains untouched.
