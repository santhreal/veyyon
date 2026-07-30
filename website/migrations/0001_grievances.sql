CREATE TABLE grievances (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	install_id TEXT NOT NULL,
	local_id INTEGER NOT NULL,
	agent_version TEXT NOT NULL,
	model TEXT NOT NULL,
	entry_version TEXT NOT NULL,
	tool TEXT NOT NULL,
	report TEXT NOT NULL,
	platform TEXT NOT NULL,
	arch TEXT NOT NULL,
	received_at TEXT NOT NULL,
	CONSTRAINT grievances_install_local_unique UNIQUE (install_id, local_id)
);

CREATE INDEX grievances_received_at_idx
	ON grievances (received_at DESC);

CREATE INDEX grievances_tool_received_at_idx
	ON grievances (tool, received_at DESC);

CREATE INDEX grievances_model_version_received_at_idx
	ON grievances (model, entry_version, received_at DESC);
