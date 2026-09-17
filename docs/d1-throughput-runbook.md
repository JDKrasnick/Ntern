# D1 throughput controller runbook

## Rollout guardrails

The controller deploys in `observation` mode. Every catalog queue delivery (GitHub, Greenhouse, Lever, and Ashby) records a P0 permit acquisition and completion with its D1 failure class, but every permit is granted and an observation failure never changes queue acknowledgement or retry behavior. Do not enable enforcement, create queues, apply migration `0030`, or configure `OPS_ALERT_RECIPIENT` without owner review of the exact OpenTofu plan and a saved production backup.

## Staged activation

1. Observe one full source cadence and review P0 queue age, DLQ growth, and D1 failure classes.
2. Validate one synthetic incident through the independently configured owner alert recipient. The recipient is a deployment secret and must not appear in logs, documentation, or application configuration.
3. Enable P2 blocking, then P1 limiting, then P0 protection after a healthy cadence at each stage. Pause P2 before investigating any D1 pressure.
4. Build R2 projections in shadow mode. Cut public reads only after count, filter, group-detail, and cursor-order parity records pass.

## Rollback

Set enforcement back to `observation`; queued work, run checkpoints, and R2 generations remain intact. If a published projection is wrong, repoint its KV pointer to the prior complete generation. Never delete a run, queue message, or additive D1 schema during rollback.
