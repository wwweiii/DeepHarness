.PHONY: audit review-draft typecheck contract-test compose-up compose-down verify

audit:
	docker compose --profile audit run --rm capability-audit

review-draft:
	docker compose --profile audit run --rm \
		--volume $(CURDIR)/config:/workspace/config \
		capability-audit bun run packages/vendor-capabilities/src/cli.ts audit --write-review-draft

contract-test:
	docker compose --profile audit run --rm capability-audit bun test tests/contract

typecheck:
	docker compose --profile audit run --rm capability-audit bun run typecheck

compose-up:
	docker compose up --build --detach --wait

compose-down:
	docker compose down

verify: audit typecheck contract-test compose-up
	docker compose ps
