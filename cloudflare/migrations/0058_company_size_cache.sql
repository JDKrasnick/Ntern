CREATE TABLE IF NOT EXISTS company_size_cache (
  company_key TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  input_domain TEXT,
  status TEXT NOT NULL CHECK (status IN ('matched', 'unmatched', 'error')),
  employee_count INTEGER CHECK (employee_count >= 0),
  provider_id TEXT,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retry_at TEXT NOT NULL
);
