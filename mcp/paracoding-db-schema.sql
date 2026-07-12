CREATE TABLE agent_state(agent_id TEXT PRIMARY KEY, status TEXT, current_task TEXT, updated_ts TEXT);
CREATE TABLE infra_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INTEGER,
  output TEXT,
  requested_ts TEXT, started_ts TEXT, done_ts TEXT);
CREATE TABLE journal(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, ts TEXT, entry TEXT);
CREATE TABLE work_items(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, title TEXT, payload TEXT, status TEXT DEFAULT 'open', claimed_by TEXT, created_ts TEXT, done_ts TEXT, result TEXT);
