-- Preserve whether the immutable source artifact was complete when the model
-- ran. Historical rows remain NULL so the operations response can report them
-- as unknown rather than assigning a source-text diagnosis retroactively.
ALTER TABLE shadow_extraction_runs ADD COLUMN input_completeness TEXT
  CHECK(input_completeness IN ('complete', 'incomplete'));

CREATE INDEX shadow_extraction_runs_input_completeness
  ON shadow_extraction_runs(origin, state, input_completeness);
