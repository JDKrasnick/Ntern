-- The tie-breaker budget parked an employer whenever the 30-day window had not
-- lapsed, even when the evidence fingerprint had changed — a new posting, a
-- corrected link, or a resolver version that reads the same link differently — so a
-- sweep marked the task `tie-break-budget-exhausted` without the model ever seeing
-- the current evidence. The resolver now asks a changed question instead of parking
-- it, but the rows a previous sweep already parked still carry a future
-- `next_retry_at` and would wait out the window.
--
-- Re-arm only the rows the old rule parked whose evidence differs from the last
-- tie-breaker, so the next scheduled sweep decides them under the corrected budget.
-- Evidence the model already considered keeps its window, and every other outcome
-- (no-reliable-domain, corporate-redirect-review, image-unavailable) is left alone.
UPDATE employer_icon_resolutions AS task
SET next_retry_at = '1970-01-01T00:00:00.000Z',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE task.status = 'unresolved'
  AND json_valid(task.evidence_json)
  AND json_extract(task.evidence_json, '$.reasonCode') = 'tie-break-budget-exhausted'
  AND EXISTS (
    SELECT 1 FROM canonical_employers AS employer
    WHERE employer.id = task.canonical_employer_id
      AND employer.icon_tie_break_at IS NOT NULL
      AND (employer.icon_tie_break_fingerprint IS NULL
        OR employer.icon_tie_break_fingerprint <> task.evidence_fingerprint)
  );

PRAGMA optimize;
