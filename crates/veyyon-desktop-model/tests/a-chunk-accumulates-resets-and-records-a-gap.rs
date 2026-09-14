//! WHY: terminal output bytes and process log lines arrive in chunks. A
//! reducer that replaced on each chunk would show only the last write; one
//! that accumulated without bound would grow until the window died; one that
//! ignored sequence numbers would splice a late chunk in silently.
//!
//! CLASS CLOSED: a chunk kind that replaces instead of accumulating, that
//! ignores its reset flag, that exceeds its declared capacity, or that
//! records no gap when a sequence number is skipped. Both chunk kinds in
//! `SnapshotSection` are here; the replacing sections are in
//! `a-domain-section-replaces-its-domain.rs`.
//!
//! NOT CAUGHT: how the drawer draws the buffer, which is the surface crate's.

use veyyon_desktop_model::{
	HostEvent, PROCESS_LOG_CAPACITY_LINES, ProcessLogsChunk, SeqGap, SnapshotSection, Store,
	TERMINAL_SCROLLBACK_CAPACITY_BYTES, TerminalOutputChunk, reduce,
};

#[test]
fn terminal_output_accumulates_resets_bounds_and_records_gaps() {
	let mut store = Store::new();

	// Chunk 1: Initial reset chunk with seq 1
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
			terminal: "term-1".to_string(),
			seq:      1,
			data:     vec![1, 2, 3],
			reset:    true,
		})),
	);

	let scrollback = store.domains.terminal_output.get("term-1").unwrap();
	assert_eq!(scrollback.data, vec![1, 2, 3]);
	assert_eq!(scrollback.last_seq, Some(1));
	assert!(scrollback.gaps.is_empty());

	// Chunk 2: Contiguous chunk seq 2 accumulates
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
			terminal: "term-1".to_string(),
			seq:      2,
			data:     vec![4, 5],
			reset:    false,
		})),
	);

	let scrollback = store.domains.terminal_output.get("term-1").unwrap();
	assert_eq!(scrollback.data, vec![1, 2, 3, 4, 5]);
	assert_eq!(scrollback.last_seq, Some(2));
	assert!(scrollback.gaps.is_empty());

	// Chunk 3: Out-of-order chunk seq 5 (gap: expected 3, received 5)
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
			terminal: "term-1".to_string(),
			seq:      5,
			data:     vec![6, 7],
			reset:    false,
		})),
	);

	let scrollback = store.domains.terminal_output.get("term-1").unwrap();
	assert_eq!(scrollback.data, vec![1, 2, 3, 4, 5, 6, 7]);
	assert_eq!(scrollback.last_seq, Some(5));
	assert_eq!(scrollback.gaps, vec![SeqGap { expected: 3, received: 5 }]);

	// Chunk 4: Reset chunk clears buffer and gaps
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
			terminal: "term-1".to_string(),
			seq:      10,
			data:     vec![8, 9],
			reset:    true,
		})),
	);

	let scrollback = store.domains.terminal_output.get("term-1").unwrap();
	assert_eq!(scrollback.data, vec![8, 9]);
	assert_eq!(scrollback.last_seq, Some(10));
	assert!(scrollback.gaps.is_empty());

	// Chunk 5: Capacity limit of 1 MiB is enforced and oldest bytes are dropped
	let oversized_payload = vec![42u8; TERMINAL_SCROLLBACK_CAPACITY_BYTES + 500];
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
			terminal: "term-1".to_string(),
			seq:      11,
			data:     oversized_payload,
			reset:    false,
		})),
	);

	let scrollback = store.domains.terminal_output.get("term-1").unwrap();
	assert_eq!(
		scrollback.data.len(),
		TERMINAL_SCROLLBACK_CAPACITY_BYTES,
		"scrollback capacity must be capped at 1 MiB"
	);
	assert_eq!(scrollback.data[0], 42);
	assert_eq!(scrollback.data[TERMINAL_SCROLLBACK_CAPACITY_BYTES - 1], 42);
}

#[test]
fn process_logs_accumulate_resets_and_bounds_to_capacity() {
	let mut store = Store::new();

	// Chunk 1: Initial reset chunk
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::ProcessLogs(ProcessLogsChunk {
			process: "web".to_string(),
			lines:   vec!["Starting server...".to_string(), "Listening on 5173".to_string()],
			cursor:  100,
			reset:   true,
		})),
	);

	let log_view = store.domains.process_logs.get("web").unwrap();
	assert_eq!(log_view.lines, vec![
		"Starting server...".to_string(),
		"Listening on 5173".to_string()
	]);
	assert_eq!(log_view.cursor, 100);

	// Chunk 2: Non-reset chunk accumulates lines and updates cursor
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::ProcessLogs(ProcessLogsChunk {
			process: "web".to_string(),
			lines:   vec!["GET / 200".to_string()],
			cursor:  150,
			reset:   false,
		})),
	);

	let log_view = store.domains.process_logs.get("web").unwrap();
	assert_eq!(log_view.lines, vec![
		"Starting server...".to_string(),
		"Listening on 5173".to_string(),
		"GET / 200".to_string()
	]);
	assert_eq!(log_view.cursor, 150);

	// Chunk 3: Reset chunk clears buffer
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::ProcessLogs(ProcessLogsChunk {
			process: "web".to_string(),
			lines:   vec!["Restarting...".to_string()],
			cursor:  200,
			reset:   true,
		})),
	);

	let log_view = store.domains.process_logs.get("web").unwrap();
	assert_eq!(log_view.lines, vec!["Restarting...".to_string()]);
	assert_eq!(log_view.cursor, 200);

	// Chunk 4: Capacity limit of 10,000 lines is strictly bounded
	let many_lines: Vec<String> = (0..PROCESS_LOG_CAPACITY_LINES + 500)
		.map(|i| format!("log line {i}"))
		.collect();
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::ProcessLogs(ProcessLogsChunk {
			process: "web".to_string(),
			lines:   many_lines,
			cursor:  5000,
			reset:   false,
		})),
	);

	let log_view = store.domains.process_logs.get("web").unwrap();
	assert_eq!(
		log_view.lines.len(),
		PROCESS_LOG_CAPACITY_LINES,
		"process logs must be capped at 10,000 lines"
	);
	assert_eq!(log_view.lines[0], "log line 500");
	assert_eq!(
		log_view.lines[PROCESS_LOG_CAPACITY_LINES - 1],
		format!("log line {}", PROCESS_LOG_CAPACITY_LINES + 499)
	);
	assert_eq!(log_view.cursor, 5000);
}
