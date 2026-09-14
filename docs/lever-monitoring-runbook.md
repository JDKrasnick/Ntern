# Lever monitoring and recovery runbook

## Operator surface

Use `https://monitoring.jdkrasnick.com` for source health, incidents, queue
depth, alarms, recent trusted runs, and recovery controls. The site proxies the
private shared operations API; do not copy its server-to-server credential into
browser storage, source code, documentation, or shell history.

Each Lever source exposes these safe controls:

- **Pause / resume** — stop or restore scheduled work without a deployment.
- **Replay now** — enqueue one FIFO task for the selected source.
- **Set active / quiet** — update the source's monitoring classification;
  published boards remain on the thirty-minute cadence.
- **Acknowledge / resolve** — record incident ownership and resolution.

Pause, tier, and incident changes are versioned in the source health record.
Promotion between shadow and published remains a reviewed configuration change.

## Monthly monitoring review

The shared pane starts a fresh checklist each calendar month for both
Greenhouse and Lever:

- review fleet health and recent failed extractions;
- confirm both provider dead-letter queues are empty or understood;
- exercise pause, resume, and replay on one shadow source from each provider;
- verify the combined reminder email; and
- confirm the latest nightly live contract.

A combined reminder is sent every Monday at 9:00 AM America/New_York while any
item remains incomplete. It includes current dead-letter messages, failed
extractions from the previous 24 hours, stale and quarantined sources, active
alarms, and queue depth. Completing every item suppresses email for the rest of
the month; the next month resets automatically.

## First response

1. Confirm whether the problem is one source, one Lever region, or the whole
   work queue.
2. Read the source's last trusted success, safe failure category, counts,
   retry/backoff state, and recent runs.
3. Confirm the dashboard says the catalog was preserved. A rejected or failed
   snapshot must not advance the checkpoint.
4. Acknowledge the incident, then use the matching procedure below.
5. Resolve only after a trusted success or a reviewed configuration repair.

## Failure procedures

### Global or EU Lever outage

- Check whether several sources in the same region are stale or returning
  temporary provider errors.
- Leave last-known-good catalog entries intact.
- Do not replay every source while provider backoff is active.
- Page when active sources cross 90 minutes or the work queue is exhausted.

### `429`, timeout, or `5xx`

- Inspect `backoffUntil`; bounded in-process retries have already run.
- Wait for provider backoff unless the provider has recovered.
- Replay one representative source before resuming broader work.
- Do not classify a temporary error as invalid configuration.

### Invalid site or region (`404`, `401`, `403`)

- Pause the source.
- Re-run the deterministic ownership and regional-host probe.
- Repair reviewed configuration and evidence; never guess a replacement site.
- Resume and replay once, then verify a trusted complete snapshot.

### Malformed JSON, schema drift, pagination, or duplicate IDs

- Keep the source paused or quarantined.
- Run the sanitized fixture contract to distinguish a code regression from
  upstream drift.
- For pagination, confirm every page completed and IDs are unique.
- Release a reviewed adapter fix before replaying production.

### Unexpected raw zero

- Compare against the last trusted raw count and the public board.
- Do not accept the empty snapshot after a previously non-empty board until the
  board closure is confirmed.
- A valid non-empty board with zero eligible internships is normal. It remains
  on the published cadence while being classified as quiet.
- A board whose `GET api.lever.co/v0/postings/{site}` still returns `200` for
  its reviewed site but lists no postings is empty, not broken; a removed site
  returns `404`. Do not force-replay it. Confirm the closure with the employer
  page, then record an `emptyBoardAcknowledged` declaration on the reviewed
  source (owner, UTC check time, reason). The declaration makes the board
  dormant: zero rows are expected rather than parser drift, while identity,
  site, host, and link checks still apply, and monitoring continues. Replay the
  board once after recording the declaration so the forced run clears the
  quarantine, then resume it when that run reports healthy. A declaration
  expires after 180 days. Remove it when the board refills.

### Application-host mismatch or broken links

- Withhold an isolated invalid role.
- Pause the source when the mismatch is widespread or changes region/site
  identity.
- Re-check first-party ownership evidence and the application redirect hosts.

### Catalog write or exhausted queue

- Stop replays until DynamoDB or the queue is healthy.
- Inspect the dead-letter count and worker alarm.
- Redrive only the selected source after catalog writes succeed.
- Deterministic outbox IDs and the quiet baseline keep safe replays from
  duplicating notifications.

## Recovery verification

A recovery is complete when:

- the selected source records a trusted `success_changed`,
  `success_unchanged_304`, or `success_unchanged_hash`;
- freshness returns below the applicable threshold;
- queue and dead-letter counts are normal;
- no identity, schema, pagination, or host-contract rejection remains; and
- the incident is resolved in the shared operations pane.
