.PHONY: audit review-draft typecheck contract-test unit-test integration-test e2e-test compose-up compose-up-test compose-down verify

TEST_COMPOSE = docker compose -f compose.yaml -f compose.test.yaml

audit:
	$(TEST_COMPOSE) --profile audit run --rm capability-audit bun run \
		packages/vendor-capabilities/src/cli.ts audit \
		--previous artifacts/capabilities/vendor-capability-manifest.json \
		--artifacts /tmp/deepharness-capability-audit

review-draft:
	$(TEST_COMPOSE) --profile audit run --rm \
		--volume $(CURDIR)/config:/workspace/config \
		capability-audit bun run packages/vendor-capabilities/src/cli.ts audit --write-review-draft

contract-test:
	docker compose --profile audit run --rm capability-audit bun test tests/contract

unit-test:
	docker compose --profile audit run --rm capability-audit bun test tests/unit

integration-test:
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		capability-audit bun test --timeout 60000 ./tests/integration/phase-1-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 180000 ./tests/integration/phase-2-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env WORKER_TEST_URL=http://worker:8081 \
		--env WORKER_SHARED_TOKEN=phase-1-local-token \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 240000 ./tests/integration/phase-3-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env WORKER_TEST_URL=http://worker:8081 \
		--env WORKER_SHARED_TOKEN=phase-1-local-token \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 240000 ./tests/integration/phase-4-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env WORKER_TEST_URL=http://worker:8081 \
		--env WORKER_SHARED_TOKEN=phase-1-local-token \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 240000 ./tests/integration/phase-5-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env WORKER_TEST_URL=http://worker:8081 \
		--env WORKER_SHARED_TOKEN=phase-1-local-token \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 180000 ./tests/integration/phase-7-stack.test.ts
	$(TEST_COMPOSE) --profile audit run --rm \
		--env TEST_BASE_URL=http://gateway:8080 \
		--env WORKER_TEST_URL=http://worker:8081 \
		--env WORKER_SHARED_TOKEN=phase-1-local-token \
		--env DATABASE_URL=postgres://deepharness:deepharness-local-only@postgres:5432/deepharness \
		capability-audit bun test --timeout 180000 ./tests/integration/phase-8-stack.test.ts

e2e-test:
	$(TEST_COMPOSE) --profile test up --build --detach --wait --force-recreate
	$(TEST_COMPOSE) --profile test --profile e2e run --build --no-deps --rm e2e

typecheck:
	docker compose --profile audit run --rm capability-audit bun run typecheck

compose-up:
	docker compose up --build --detach --wait

compose-up-test:
	$(TEST_COMPOSE) --profile test up --build --detach --wait --force-recreate

compose-down:
	docker compose down

verify: audit typecheck contract-test unit-test compose-up-test integration-test e2e-test
	$(TEST_COMPOSE) --profile test ps
