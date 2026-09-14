# Greenhouse monitoring

InternNotifs reads the public Greenhouse Job Board API for reviewed employer
boards. It never submits applications and never trusts an unreviewed board
token or application host.

## Documents

- [Architecture](architecture.md) — deployed queue, worker, shadow, publication,
  retry, and alert flow.
- [Ingestion plan](ingestion-plan.md) — source contract, mapping, quality gates,
  and rollout requirements.
- [Registry expansion plan](registry-expansion-plan.md) — broad discovery,
  deterministic verification, evidence review, and production promotion.

## Current operating contract

- The independently deployable `InternNotifsGreenhouse` stack imports the
  retained DynamoDB tables and does not own the main application resources.
- EventBridge dispatches reviewed boards every thirty minutes. Published boards
  run on every dispatch; shadow boards run on staggered three-hour checks.
- A FIFO SQS queue preserves ordering per board and deduplicates a board within
  the dispatch window.
- Lambda consumes batches of ten with maximum concurrency four.
- Shadow boards write only isolated source checkpoints and logs.
- A board the owner has confirmed genuinely empty carries an
  `emptyBoardAcknowledged` declaration: its zero-row snapshots are expected
  instead of failing the suspicious-zero gate, and the board keeps monitoring.
  Record the declaration, replay the board once so the forced run clears the
  quarantine, and resume it when that run reports healthy. The declaration
  expires after 180 days and must be re-checked.
- Published boards use the catalog poller, quiet first baseline, link
  validation, DynamoDB deduplication, and user alert path.
- Each request to the Greenhouse jobs API has an eight-second timeout.
- Individual failed SQS records retry without replaying successful records and
  move to a dedicated dead-letter queue after four receives.

No reviewed board is promoted merely because the worker exists. Promotion
still requires its registry status to change from `shadow` to `published`.
