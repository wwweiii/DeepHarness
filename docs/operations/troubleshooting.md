# Troubleshooting

## Gateway does not become ready

Check `docker compose logs postgres gateway`, then run `docker compose exec postgres pg_isready`. A production Gateway with `AUTH_ENABLED=1` refuses to boot when `ADMIN_PASSWORD` is missing or shorter than 12 characters. A missing capability manifest is also a startup error; run `make audit` and mount the generated artifact into the Gateway image.

## Browser reports 401 or 403

Call `/api/auth/session` first. A 401 means the session cookie is absent, expired, or revoked. A 403 on a write means the `X-CSRF-Token` header does not match `deepharness_csrf`; call `/api/auth/csrf` and retry. Do not disable CSRF in production.

## Worker is disconnected

Verify the shared token, Gateway DNS name, and `docker compose logs worker`. The Worker reconnects automatically. A disconnected browser does not cancel a durable Goal, Workflow, Cron, or background job; use the background job API to attach or stop it.

## Capability gate fails

Read `artifacts/capabilities/vendor-capability-diff.json`. Unreviewed additions and A/B regressions are release blockers. C gaps must retain an expected-failure probe and an upstream strategy; D entries need an explicit Compose profile; E entries are intentionally non-core. Update the review file and evidence in the same change as a vendor pointer update.

## Restore or rollback

Run `make backup` before an upgrade and retain the database dump, Compose hash, DeepHarness commit, and vendor commit together. Run `make restore-check BACKUP_DIR=...` against an isolated Compose project. Roll back by redeploying the previous image tag and the previous vendor submodule pointer; never edit vendor source to repair an upgrade.
