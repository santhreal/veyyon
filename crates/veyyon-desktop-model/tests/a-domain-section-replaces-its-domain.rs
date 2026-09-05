//! WHY: a domain section the host sends is the whole of that domain at that
//! moment. A reducer that merged it with what it held would show a file the
//! host no longer lists, a terminal that exited, a provider that was removed.
//!
//! CLASS CLOSED: a `SnapshotSection` variant whose reduction merges rather
//! than replaces. The variants are swept from `SnapshotSectionKind` at run
//! time, and the match on each kind is exhaustive, so a section added to the
//! protocol fails to compile here until it is given a pair or recorded as one
//! that does not land in `Domains`. The replacement invariant is generic:
//! reducing A then B leaves `Domains` equal to reducing B alone.
//!
//! NOT CAUGHT: the sections that do not land in `Domains`. Sessions, the
//! active session, the transcript, capabilities and interactions have their
//! own suites; the two chunk kinds accumulate by design and are in
//! `a-chunk-accumulates-resets-and-records-a-gap.rs`.

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	AgentView, AuthFlowState, AuthFlowView, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ContextBreakdownView, ContextCategory, ExportView, FileContentView, FileKind, FileNode,
	FileTreeView, HostEvent, InputModality, KeybindingView, McpServerStatus, McpServerView,
	McpToolResultView, ModelRef, ModelView, ModelsView, ProcessView, ProviderView,
	SearchResultsView, SessionId, SettingEntry, SettingKind, SettingsView, SnapshotSection,
	SnapshotSectionKind, Store, TerminalStatus, TerminalView, ThemeView, ThemesView, UsageTotals,
	UsageView, reduce,
};

fn changed(path: &str, status: ChangeStatus) -> ChangedFile {
	ChangedFile { path: path.into(), previous_path: None, status, additions: 1, deletions: 0 }
}

fn changes(revision: u64, scope: ChangeScope, file: ChangedFile) -> SnapshotSection {
	SnapshotSection::Changes(ChangesView {
		revision,
		repository: Some("/repo".into()),
		scope,
		files: vec![file],
		diff: format!("diff {revision}"),
	})
}

fn node(path: &str, kind: FileKind, depth: u32) -> FileNode {
	FileNode { path: path.into(), name: path.rsplit('/').next().unwrap_or(path).into(), kind, depth }
}

fn file_tree(entries: Vec<FileNode>) -> SnapshotSection {
	SnapshotSection::FileTree(FileTreeView { root: "/repo".into(), entries, truncated: false })
}

fn file_content(content: &str) -> SnapshotSection {
	SnapshotSection::FileContent(FileContentView {
		path:       "src/lib.rs".into(),
		content:    content.into(),
		size_bytes: content.len() as u64,
		truncated:  false,
		binary:     false,
	})
}

fn search(query: &str, paths: &[&str]) -> SnapshotSection {
	SnapshotSection::SearchResults(SearchResultsView {
		query:     query.into(),
		paths:     paths.iter().map(|p| (*p).to_owned()).collect(),
		truncated: false,
	})
}

fn terminal(id: &str, status: TerminalStatus) -> SnapshotSection {
	SnapshotSection::Terminals(vec![TerminalView {
		id: id.into(),
		cwd: "/repo".into(),
		shell: "/bin/sh".into(),
		cols: 80,
		rows: 24,
		status,
	}])
}

fn process(name: &str, exit_code: Option<i32>) -> SnapshotSection {
	SnapshotSection::Processes(vec![ProcessView {
		name: name.into(),
		pid: Some(100),
		status: if exit_code.is_some() {
			"exited"
		} else {
			"running"
		}
		.into(),
		application: "cargo".into(),
		args: vec!["test".into()],
		cwd: "/repo".into(),
		lifetime: "detached".into(),
		started_at_ms: 1000,
		exit_code,
		terminated_by: exit_code.map(|_| "process-exit".to_owned()),
	}])
}

fn models(id: &str, reasoning: bool) -> SnapshotSection {
	SnapshotSection::Models(ModelsView {
		models:          vec![ModelView {
			provider: "anthropic".into(),
			id: id.into(),
			name: id.into(),
			reasoning,
			context_window: 200_000,
			max_output: 64_000,
			input: vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef { provider: "anthropic".into(), id: id.into() }),
		thinking_level:  reasoning.then(|| "high".to_owned()),
		thinking_levels: if reasoning {
			vec!["low".into(), "high".into()]
		} else {
			Vec::new()
		},
	})
}

fn provider(id: &str, authenticated: bool) -> SnapshotSection {
	SnapshotSection::Providers(vec![ProviderView {
		id: id.into(),
		name: id.into(),
		authenticated,
		oauth: authenticated,
		api_key: true,
	}])
}

fn auth_flow(state: AuthFlowState) -> SnapshotSection {
	let done = matches!(state, AuthFlowState::Completed);
	SnapshotSection::AuthFlow(AuthFlowView {
		provider: "anthropic".into(),
		state,
		url: (!done).then(|| "https://example.com/oauth".to_owned()),
		prompt: None,
		message: done.then(|| "Success".to_owned()),
	})
}

fn mcp(status: McpServerStatus, tools: &[&str]) -> SnapshotSection {
	SnapshotSection::Mcp(vec![McpServerView {
		name: "fs".into(),
		enabled: true,
		status,
		tools: tools.iter().map(|t| (*t).to_owned()).collect(),
	}])
}

fn mcp_tool_result(is_error: bool, output: &str) -> SnapshotSection {
	SnapshotSection::McpToolResult(McpToolResultView {
		server: "fs".into(),
		tool: "read_file".into(),
		is_error,
		output: output.into(),
	})
}

fn agent(id: &str, status: &str) -> SnapshotSection {
	SnapshotSection::Agents(vec![AgentView {
		id:           id.into(),
		display_name: id.into(),
		kind:         "task".into(),
		status:       status.into(),
		parent:       None,
		scope:        "/repo".into(),
		session:      None,
	}])
}

fn usage(input_tokens: u64) -> SnapshotSection {
	SnapshotSection::Usage(UsageView {
		session: SessionId::from("sess-1"),
		totals:  UsageTotals {
			input_tokens,
			output_tokens: 50,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			orchestration_tokens: 0,
			premium_requests: 0,
			cost_microusd: Some(100),
		},
	})
}

fn context(categories: &[(&str, u64)]) -> SnapshotSection {
	SnapshotSection::ContextBreakdown(ContextBreakdownView {
		session:      SessionId::from("sess-1"),
		total_tokens: categories.iter().map(|(_, tokens)| tokens).sum(),
		limit_tokens: Some(10_000),
		categories:   categories
			.iter()
			.map(|(name, tokens)| ContextCategory { name: (*name).to_owned(), tokens: *tokens })
			.collect(),
	})
}

fn export(format: &str) -> SnapshotSection {
	SnapshotSection::Export(ExportView {
		session: SessionId::from("sess-1"),
		format:  format.into(),
		path:    Some(format!("/repo/export.{format}")),
		content: None,
	})
}

fn themes(current: &str, dark: bool) -> SnapshotSection {
	SnapshotSection::Themes(ThemesView {
		themes:  vec![ThemeView { id: current.into(), name: current.into(), dark }],
		current: current.into(),
	})
}

fn keybinding(action: &str, key: &str) -> SnapshotSection {
	SnapshotSection::Keybindings(vec![KeybindingView {
		action: action.into(),
		keys:   vec![key.into()],
		source: "default".into(),
	}])
}

fn settings(entries: &[(&str, serde_json::Value)]) -> SnapshotSection {
	let view: SettingsView = entries
		.iter()
		.map(|(key, value)| {
			((*key).to_owned(), SettingEntry {
				value:       value.clone(),
				default:     serde_json::Value::String("dark".into()),
				source:      "profile".into(),
				kind:        SettingKind::String,
				label:       None,
				description: None,
				tab:         None,
				group:       None,
				values:      Vec::new(),
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			})
		})
		.collect();
	SnapshotSection::Settings(view)
}

/// Two distinct sections of one kind, or `None` for a kind that does not
/// land in `Domains`. The match is exhaustive on purpose.
fn pair(kind: SnapshotSectionKind) -> Option<[SnapshotSection; 2]> {
	Some(match kind {
		SnapshotSectionKind::Sessions
		| SnapshotSectionKind::ActiveSession
		| SnapshotSectionKind::Transcript
		| SnapshotSectionKind::Capabilities
		| SnapshotSectionKind::Interactions
		| SnapshotSectionKind::TerminalOutput
		| SnapshotSectionKind::ProcessLogs => return None,
		SnapshotSectionKind::Settings => [
			settings(&[("theme", "light".into())]),
			settings(&[("theme", "dark".into()), ("argot.enabled", true.into())]),
		],
		SnapshotSectionKind::Diagnostics => [
			SnapshotSection::Diagnostics(serde_json::json!({ "status": "init" })),
			SnapshotSection::Diagnostics(serde_json::json!({ "status": "ready", "sources": [] })),
		],
		SnapshotSectionKind::Changes => [
			changes(1, ChangeScope::WorkingTree, changed("a.rs", ChangeStatus::Modified)),
			changes(2, ChangeScope::Staged, changed("b.rs", ChangeStatus::Added)),
		],
		SnapshotSectionKind::FileTree => [
			file_tree(vec![node("src", FileKind::Directory, 0)]),
			file_tree(vec![node("src/lib.rs", FileKind::File, 1)]),
		],
		SnapshotSectionKind::FileContent => [file_content("// v1"), file_content("// v2")],
		SnapshotSectionKind::SearchResults => {
			[search("foo", &["a.rs"]), search("bar", &["b.rs", "c.rs"])]
		},
		SnapshotSectionKind::Terminals => [
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Exited { code: 0 }),
		],
		SnapshotSectionKind::Processes => [process("web", None), process("worker", Some(0))],
		SnapshotSectionKind::Models => [models("claude-3", false), models("claude-sonnet-4", true)],
		SnapshotSectionKind::Providers => [provider("openai", false), provider("anthropic", true)],
		SnapshotSectionKind::AuthFlow => {
			[auth_flow(AuthFlowState::AwaitingBrowser), auth_flow(AuthFlowState::Completed)]
		},
		SnapshotSectionKind::Mcp => {
			[mcp(McpServerStatus::Connecting, &[]), mcp(McpServerStatus::Connected, &["read_file"])]
		},
		SnapshotSectionKind::McpToolResult => {
			[mcp_tool_result(false, "out"), mcp_tool_result(true, "error")]
		},
		SnapshotSectionKind::Agents => [agent("agent-1", "running"), agent("agent-2", "completed")],
		SnapshotSectionKind::Usage => [usage(100), usage(500)],
		SnapshotSectionKind::ContextBreakdown => {
			[context(&[("system", 1000)]), context(&[("system", 1000), ("messages", 1500)])]
		},
		SnapshotSectionKind::Export => [export("html"), export("md")],
		SnapshotSectionKind::Themes => [themes("light", false), themes("dark", true)],
		SnapshotSectionKind::Keybindings => {
			[keybinding("app.quit", "ctrl+q"), keybinding("composer.submit", "enter")]
		},
	})
}

#[test]
fn every_domain_section_replaces_its_domain_and_the_opt_outs_are_named() {
	let mut opted_out = Vec::new();
	for kind in SnapshotSectionKind::iter() {
		let Some([first, second]) = pair(kind) else {
			opted_out.push(kind);
			continue;
		};
		assert_eq!(SnapshotSectionKind::from(&first), kind);
		assert_eq!(SnapshotSectionKind::from(&second), kind);
		assert_ne!(first, second, "{kind:?}: a pair of equal sections proves nothing");

		let mut store = Store::new();
		let untouched = store.domains.clone();
		reduce(&mut store, HostEvent::Snapshot(first));
		let after_first = store.domains.clone();
		assert_ne!(after_first, untouched, "{kind:?}: the first section landed nowhere");
		reduce(&mut store, HostEvent::Snapshot(second.clone()));
		assert_ne!(store.domains, after_first, "{kind:?}: the second section landed nowhere");

		let mut alone = Store::new();
		reduce(&mut alone, HostEvent::Snapshot(second));
		assert_eq!(
			store.domains, alone.domains,
			"{kind:?}: reducing two sections in turn differs from reducing the last alone, so the \
			 reducer merged what the host replaced"
		);
	}
	assert_eq!(opted_out, [
		SnapshotSectionKind::Sessions,
		SnapshotSectionKind::ActiveSession,
		SnapshotSectionKind::Transcript,
		SnapshotSectionKind::Capabilities,
		SnapshotSectionKind::Interactions,
		SnapshotSectionKind::TerminalOutput,
		SnapshotSectionKind::ProcessLogs,
	]);
}
