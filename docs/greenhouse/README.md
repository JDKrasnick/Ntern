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

- The `intern-notifs-ingestion` Worker owns Greenhouse Cron dispatch and the
  provider queue consumer; the public API Worker owns no schedules or consumers.
- Cloudflare Cron Triggers dispatch reviewed boards. Published boards run every
  thirty minutes; shadow boards run on staggered three-hour checks.
- The Greenhouse Cloudflare Queue preserves one-source-at-a-time processing;
  its consumer uses batches of one with maximum concurrency six.
- Shadow boards write only isolated source checkpoints and logs.
- A board the owner has confirmed genuinely empty carries an
  `emptyBoardAcknowledged` declaration: its zero-row snapshots are expected
  instead of failing the suspicious-zero gate, and the board keeps monitoring.
  Record the declaration, replay the board once so the forced run clears the
  quarantine, and resume it when that run reports healthy. The declaration
  expires after 180 days and must be re-checked.
- Published boards use the catalog poller, quiet first baseline, link
  validation, atomic D1 reconciliation, and user alert path.
- Each request to the Greenhouse jobs API has an eight-second timeout.
- Failed messages retry twice. A source-scoped failure that survives the final
  delivery records its health and failure-ledger rows and is acknowledged,
  because the dispatcher re-issues the source from its health row and
  checkpoint. Only a message the dispatcher cannot re-own (an unknown source or
  a malformed body) moves to the dedicated Greenhouse DLQ.

No reviewed board is promoted merely because the worker exists. Promotion
still requires its registry status to change from `shadow` to `published`.
