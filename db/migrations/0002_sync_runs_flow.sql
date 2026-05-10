-- Attach sync_runs to the specific flow that triggered them, so the
-- dashboard can answer "when did THIS flow last run?". tenant_id stays
-- for tenant-wide aggregations.
ALTER TABLE sync_runs ADD COLUMN sync_flow_id TEXT REFERENCES sync_flows(id);
CREATE INDEX idx_runs_flow_started ON sync_runs(sync_flow_id, started_at DESC);
