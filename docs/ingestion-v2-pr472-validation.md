# Ingestion V2 Part 2 coverage for PR 472

The implementation retains the full-board discovery diff and independently
settled admission rows. The following tests cover the Part 2 requirements and
the Stage 3 catalog effects that consume their decisions.

| Requirement | Regression evidence |
| --- | --- |
| Immutable, complete normalized snapshots; ordering and historical parser parity | `ingestion-v2-unit`, `ingestion-v2-shadow.integration`; `npm run test:ingestion:history` |
| Versioned deterministic messages with at most 25 IDs; dedicated queue/DLQ and disabled controls | `ingestion-v2-admission-unit`, `cloudflare-admission-v2`, built Worker admission E2E |
| Durable handoff before sending; lost handoff and expired lease recovery | `ingestion-v2-admission.integration`, `ingestion-v2-admission-queue`, `ingestion-v2-dispatch-race` |
| Producer races cannot clear a current lease, effect claim, identity, or future retry deadline | `ingestion-v2-dispatch-race` |
| Independent admitted, blocked, shelved, retrying, and quarantined rows | `ingestion-v2-admission.integration`, `ingestion-v2-admission-queue`, built Worker admission E2E |
| Initial attempt, 60-second retry, five-minute retry, then quarantine | `ingestion-v2-admission-unit`, `ingestion-v2-admission.integration`, built Worker admission E2E |
| D1/R2/queue/resource failures do not consume row attempts | `cloudflare-admission-v2`, `ingestion-v2-admission.integration`, `destination-queue-resilience.integration` |
| Content, policy, reappearance, and guarded replay reopen work | `ingestion-v2-policy-reopen`, `ingestion-v2-omission-closure`, built Worker operations E2E |
| Policy migration covers all retained states, keeps visible roles, and stays silent | `ingestion-v2-policy-reopen`, `ingestion-v2-two-cadence.integration`, `ingestion-v2-bootstrap` |
| Negative decisions revoke public occurrences without closing live peer sources | `ingestion-v2-omission-closure`; built Worker admission E2E checks persisted occurrence and job |
| Two complete omissions close public roles; durable bounded closure resumes after failure | `ingestion-v2-omission-closure`, including quarantined/in-flight rows, reappearance, and more than 25 closures |
| Stale claimed positive/negative effects cannot overwrite a newer observation or publish after two complete omissions | `ingestion-v2-omission-closure` with D1 transaction fences |
| Baseline provenance survives quarantine and material changes; durable silence overrides old messages and in-flight evaluation | `ingestion-v2-baseline-origin.integration`, `ingestion-v2-notification-baseline-race.integration`, `ingestion-v2-during-lease-baseline.integration`, `ingestion-v2-baseline-lease-race` |
| Nonexact trusted roles promote once after two complete cadences | `ingestion-v2-two-cadence.integration`: duplicates, retries, delayed consumption, changed material, omissions, gaps, and 570 promotions |
| Unchanged settled roles avoid expensive evaluation | `ingestion-v2-two-cadence.integration`: one new candidate among 570 quiet baseline roles |
| D1 bind, memory, query, snapshot-read, and publication budgets | `ingestion-resource-budget`, `ingestion-v2-d1`, built Worker large-board E2E |
| Guarded silent bootstrap, writer ownership, rollback, re-enable, and operations authentication | `ingestion-v2-bootstrap`, built Worker admission E2E |

Test names above refer to files under `test/`; built Worker tests live under
`test/e2e/`. They inspect catalog jobs, source occurrences, deterministic
notification receipts, and row state rather than inferring publication from
ledger decisions alone.

Dev validation uses isolated D1, R2, and Cloudflare Queues with a temporary
authenticated fixture driver calling the production discovery factory and
dispatcher. Mock official application pages cover 24 company labels and six
technical role types, plus DNS, HTTP 429, HTTP 503, and gone-link failures.
Source fetch/parsing and guarded operations are also exercised through the
compiled ingestion Worker locally and the six-feed historical replay.

These checks establish implementation and dev behavior. Production cohort
bootstrap, guarded cutover, live parity, rollback, seven-day soak, and eventual
legacy removal remain the separate gates in [the cutover runbook](ingestion-v2-stage3-cutover.md).
