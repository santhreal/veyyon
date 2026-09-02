//! WHY THIS SUITE EXISTS
//!
//! Domain snapshot sections received from the host represent the complete state
//! of a domain at that moment, requiring replacement of previous state, whereas
//! terminal output bytes and process log lines arrive in chunks and must
//! accumulate in memory-bounded buffers while detecting out-of-order sequence
//! gaps.
//!
//! THE CLASS THIS CLOSES: state accumulation bugs, unbounded memory growth
//! from infinite terminal/process log retention, failure to detect stream gaps,
//! and stale domain state retention across snapshot synchronization.
//!
//! WHAT IT DOES NOT CATCH: visual display and differential scroll performance
//! in the terminal/process view surfaces.

use veyyon_desktop_model::{
	AgentView, AuthFlowState, AuthFlowView, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ContextBreakdownView, ContextCategory, ExportView, FileContentView, FileKind, FileNode,
	FileTreeView, HostEvent, InputModality, KeybindingView, McpServerStatus, McpServerView,
	McpToolResultView, ModelRef, ModelView, ModelsView, PROCESS_LOG_CAPACITY_LINES,
	ProcessLogsChunk, ProcessView, ProviderView, SearchResultsView, SeqGap, SessionId, SettingEntry,
	SettingKind, SettingsView, SnapshotSection, Store, TERMINAL_SCROLLBACK_CAPACITY_BYTES,
	TerminalOutputChunk, TerminalStatus, TerminalView, ThemeView, ThemesView, UsageTotals,
	UsageView, reduce,
};

#[test]
fn domain_sections_replace_their_domain_state() {
	let mut store = Store::new();

	// 1. Changes domain replacement
	let changes1 = ChangesView {
		revision:   1,
		repository: Some("/repo1".to_string()),
		scope:      ChangeScope::WorkingTree,
		files:      vec![ChangedFile {
			path:          "file1.txt".to_string(),
			previous_path: None,
			status:        ChangeStatus::Modified,
			additions:     10,
			deletions:     2,
		}],
		diff:       "diff1".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(changes1.clone())));
	assert_eq!(store.domains.changes.as_ref(), Some(&changes1));

	let changes2 = ChangesView {
		revision:   2,
		repository: Some("/repo2".to_string()),
		scope:      ChangeScope::Staged,
		files:      vec![ChangedFile {
			path:          "file2.txt".to_string(),
			previous_path: None,
			status:        ChangeStatus::Added,
			additions:     20,
			deletions:     0,
		}],
		diff:       "diff2".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(changes2.clone())));
	assert_eq!(store.domains.changes.as_ref(), Some(&changes2));

	// 2. FileTree domain replacement
	let tree1 = FileTreeView {
		root:      "/repo".to_string(),
		entries:   vec![FileNode {
			path:  "src".to_string(),
			name:  "src".to_string(),
			kind:  FileKind::Directory,
			depth: 0,
		}],
		truncated: false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::FileTree(tree1)));
	let tree2 = FileTreeView {
		root:      "/repo".to_string(),
		entries:   vec![FileNode {
			path:  "src/lib.rs".to_string(),
			name:  "lib.rs".to_string(),
			kind:  FileKind::File,
			depth: 1,
		}],
		truncated: false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::FileTree(tree2.clone())));
	assert_eq!(store.domains.file_tree.as_ref(), Some(&tree2));

	// 3. FileContent domain replacement
	let content1 = FileContentView {
		path:       "src/lib.rs".to_string(),
		content:    "// v1".to_string(),
		size_bytes: 5,
		truncated:  false,
		binary:     false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::FileContent(content1)));
	let content2 = FileContentView {
		path:       "src/lib.rs".to_string(),
		content:    "// v2".to_string(),
		size_bytes: 5,
		truncated:  false,
		binary:     false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::FileContent(content2.clone())));
	assert_eq!(store.domains.file_content.as_ref(), Some(&content2));

	// 4. SearchResults replacement
	let search1 = SearchResultsView {
		query:     "foo".to_string(),
		paths:     vec!["a.rs".to_string()],
		truncated: false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::SearchResults(search1)));
	let search2 = SearchResultsView {
		query:     "bar".to_string(),
		paths:     vec!["b.rs".to_string(), "c.rs".to_string()],
		truncated: false,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::SearchResults(search2.clone())));
	assert_eq!(store.domains.search.as_ref(), Some(&search2));

	// 5. Terminals list replacement
	let term1 = vec![TerminalView {
		id:     "term-1".to_string(),
		cwd:    "/repo".to_string(),
		shell:  "/bin/bash".to_string(),
		cols:   80,
		rows:   24,
		status: TerminalStatus::Running,
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Terminals(term1)));
	let term2 = vec![TerminalView {
		id:     "term-2".to_string(),
		cwd:    "/repo".to_string(),
		shell:  "/bin/zsh".to_string(),
		cols:   120,
		rows:   40,
		status: TerminalStatus::Exited { code: 0 },
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Terminals(term2.clone())));
	assert_eq!(store.domains.terminals, term2);

	// 6. Processes list replacement
	let proc1 = vec![ProcessView {
		name:          "web".to_string(),
		pid:           Some(100),
		status:        "running".to_string(),
		application:   "bun".to_string(),
		args:          vec!["run".to_string(), "dev".to_string()],
		cwd:           "/repo".to_string(),
		lifetime:      "detached".to_string(),
		started_at_ms: 1000,
		exit_code:     None,
		terminated_by: None,
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Processes(proc1)));
	let proc2 = vec![ProcessView {
		name:          "worker".to_string(),
		pid:           Some(200),
		status:        "exited".to_string(),
		application:   "cargo".to_string(),
		args:          vec!["test".to_string()],
		cwd:           "/repo".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: 2000,
		exit_code:     Some(0),
		terminated_by: Some("process-exit".to_string()),
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Processes(proc2.clone())));
	assert_eq!(store.domains.processes, proc2);

	// 7. Models replacement
	let models1 = ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_string(),
			id:             "claude-3".to_string(),
			name:           "Claude 3".to_string(),
			reasoning:      false,
			context_window: 100_000,
			max_output:     4_096,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-3".to_string(),
		}),
		thinking_level:  None,
		thinking_levels: vec![],
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Models(models1)));
	let models2 = ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_string(),
			id:             "claude-sonnet-4".to_string(),
			name:           "Claude Sonnet 4".to_string(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-sonnet-4".to_string(),
		}),
		thinking_level:  Some("high".to_string()),
		thinking_levels: vec!["low".to_string(), "high".to_string()],
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Models(models2.clone())));
	assert_eq!(store.domains.models.as_ref(), Some(&models2));

	// 8. Providers replacement
	let providers1 = vec![ProviderView {
		id:            "openai".to_string(),
		name:          "OpenAI".to_string(),
		authenticated: false,
		oauth:         false,
		api_key:       true,
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Providers(providers1)));
	let providers2 = vec![ProviderView {
		id:            "anthropic".to_string(),
		name:          "Anthropic".to_string(),
		authenticated: true,
		oauth:         true,
		api_key:       true,
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Providers(providers2.clone())));
	assert_eq!(store.domains.providers, providers2);

	// 9. AuthFlow replacement
	let auth1 = AuthFlowView {
		provider: "anthropic".to_string(),
		state:    AuthFlowState::AwaitingBrowser,
		url:      Some("https://example.com/oauth".to_string()),
		prompt:   None,
		message:  None,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::AuthFlow(auth1)));
	let auth2 = AuthFlowView {
		provider: "anthropic".to_string(),
		state:    AuthFlowState::Completed,
		url:      None,
		prompt:   None,
		message:  Some("Success".to_string()),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::AuthFlow(auth2.clone())));
	assert_eq!(store.domains.auth_flow.as_ref(), Some(&auth2));

	// 10. Mcp replacement
	let mcp1 = vec![McpServerView {
		name:    "fs".to_string(),
		enabled: true,
		status:  McpServerStatus::Connecting,
		tools:   vec![],
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Mcp(mcp1)));
	let mcp2 = vec![McpServerView {
		name:    "fs".to_string(),
		enabled: true,
		status:  McpServerStatus::Connected,
		tools:   vec!["read_file".to_string()],
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Mcp(mcp2.clone())));
	assert_eq!(store.domains.mcp, mcp2);

	// 11. McpToolResult replacement
	let tool_res1 = McpToolResultView {
		server:   "fs".to_string(),
		tool:     "read_file".to_string(),
		is_error: false,
		output:   "out1".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::McpToolResult(tool_res1)));
	let tool_res2 = McpToolResultView {
		server:   "fs".to_string(),
		tool:     "read_file".to_string(),
		is_error: true,
		output:   "error".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::McpToolResult(tool_res2.clone())));
	assert_eq!(store.domains.mcp_tool_result.as_ref(), Some(&tool_res2));

	// 12. Agents replacement
	let agents1 = vec![AgentView {
		id:           "agent-1".to_string(),
		display_name: "Worker 1".to_string(),
		kind:         "task".to_string(),
		status:       "running".to_string(),
		parent:       None,
		scope:        "/repo".to_string(),
		session:      None,
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Agents(agents1)));
	let agents2 = vec![AgentView {
		id:           "agent-2".to_string(),
		display_name: "Worker 2".to_string(),
		kind:         "task".to_string(),
		status:       "completed".to_string(),
		parent:       Some("main".to_string()),
		scope:        "/repo".to_string(),
		session:      Some(SessionId::from("sess-1")),
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Agents(agents2.clone())));
	assert_eq!(store.domains.agents, agents2);

	// 13. Usage replacement
	let usage1 = UsageView {
		session: SessionId::from("sess-1"),
		totals:  UsageTotals {
			input_tokens:         100,
			output_tokens:        50,
			cache_read_tokens:    0,
			cache_write_tokens:   0,
			orchestration_tokens: 0,
			premium_requests:     0,
			cost_microusd:        Some(100),
		},
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Usage(usage1)));
	let usage2 = UsageView {
		session: SessionId::from("sess-1"),
		totals:  UsageTotals {
			input_tokens:         500,
			output_tokens:        200,
			cache_read_tokens:    100,
			cache_write_tokens:   0,
			orchestration_tokens: 0,
			premium_requests:     1,
			cost_microusd:        Some(800),
		},
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Usage(usage2.clone())));
	assert_eq!(store.domains.usage.get(&SessionId::from("sess-1")), Some(&usage2.totals));

	// 14. ContextBreakdown replacement
	let ctx1 = ContextBreakdownView {
		session:      SessionId::from("sess-1"),
		total_tokens: 1000,
		limit_tokens: Some(10000),
		categories:   vec![ContextCategory { name: "system".to_string(), tokens: 1000 }],
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ctx1)));
	let ctx2 = ContextBreakdownView {
		session:      SessionId::from("sess-1"),
		total_tokens: 2500,
		limit_tokens: Some(10000),
		categories:   vec![
			ContextCategory { name: "system".to_string(), tokens: 1000 },
			ContextCategory { name: "messages".to_string(), tokens: 1500 },
		],
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ctx2.clone())));
	assert_eq!(store.domains.context.get(&SessionId::from("sess-1")), Some(&ctx2));

	// 15. Export replacement
	let export1 = ExportView {
		session: SessionId::from("sess-1"),
		format:  "html".to_string(),
		path:    Some("/tmp/1.html".to_string()),
		content: None,
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Export(export1)));
	let export2 = ExportView {
		session: SessionId::from("sess-1"),
		format:  "markdown".to_string(),
		path:    Some("/tmp/2.md".to_string()),
		content: Some("# Export".to_string()),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Export(export2.clone())));
	assert_eq!(store.domains.export.as_ref(), Some(&export2));

	// 16. Themes replacement
	let themes1 = ThemesView {
		themes:  vec![ThemeView {
			id:   "light".to_string(),
			name: "Light".to_string(),
			dark: false,
		}],
		current: "light".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Themes(themes1)));
	let themes2 = ThemesView {
		themes:  vec![ThemeView { id: "dark".to_string(), name: "Dark".to_string(), dark: true }],
		current: "dark".to_string(),
	};
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Themes(themes2.clone())));
	assert_eq!(store.domains.themes.as_ref(), Some(&themes2));

	// 17. Keybindings replacement
	let kb1 = vec![KeybindingView {
		action: "app.quit".to_string(),
		keys:   vec!["ctrl+q".to_string()],
		source: "default".to_string(),
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Keybindings(kb1)));
	let kb2 = vec![KeybindingView {
		action: "composer.submit".to_string(),
		keys:   vec!["enter".to_string()],
		source: "user".to_string(),
	}];
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Keybindings(kb2.clone())));
	assert_eq!(store.domains.keybindings, kb2);

	// 18. Settings and Diagnostics replacement
	let entry = |value: serde_json::Value, source: &str| SettingEntry {
		value,
		default: serde_json::Value::String("dark".to_string()),
		source: source.to_string(),
		kind: SettingKind::String,
		label: None,
		description: None,
		tab: None,
		group: None,
		values: Vec::new(),
		options: Vec::new(),
		min: None,
		max: None,
		global: false,
		advanced: false,
		hidden: false,
	};
	let settings1 = SettingsView::from([("theme".to_string(), entry("light".into(), "profile"))]);
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Settings(settings1)));
	let settings2 = SettingsView::from([
		("theme".to_string(), entry("dark".into(), "default")),
		("argot.enabled".to_string(), entry(true.into(), "project")),
	]);
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Settings(settings2.clone())));
	assert_eq!(store.domains.settings.as_ref(), Some(&settings2));

	let diag1 = serde_json::json!({ "status": "init" });
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Diagnostics(diag1)));
	let diag2 = serde_json::json!({ "status": "ready", "sources": [] });
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Diagnostics(diag2.clone())));
	assert_eq!(store.domains.diagnostics.as_ref(), Some(&diag2));
}

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
