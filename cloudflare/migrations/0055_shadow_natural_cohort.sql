-- Bound the exact-version natural review cohort to its first 25 completions.
CREATE INDEX shadow_extraction_natural_cohort
ON shadow_extraction_runs(model_id, prompt_version, schema_version, preprocessing_version, completed_at, run_key)
WHERE state = 'completed' AND origin IN ('provider-poll', 'scheduled-verification');
