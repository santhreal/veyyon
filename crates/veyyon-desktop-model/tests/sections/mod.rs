//! Two sections of each domain the host sends, differing in what they carry,
//! so a suite can reduce one after the other and read what is left.
//!
//! These state the protocol's shape rather than the invariant under test, so
//! they sit beside the suite that sweeps them instead of inside it.

use veyyon_desktop_model::{
	AgentMessageOutcome, AgentMessageView, AgentView, AuthFlowState, AuthFlowView, ChangeScope,
	ChangeStatus, ChangedFile, ChangesView, CommandSource, CommandView, ContentMatch,
	ContentMatchesView, ContextBreakdownView, ContextCategory, ExportView, FileContentView,
	FileKind, FileNode, FileTreeView, InputModality, KeybindingView, McpServerStatus, McpServerView,
	ModelRef, ModelView, ModelsView, ProcessView, ProviderView, SearchResultsView, SessionId,
	SessionSearchView, SessionTranscriptView, SettingEntry, SettingKind, SettingsView,
	SnapshotSection, SnapshotSectionKind, TerminalStatus, TerminalView, ThemeView, ThemesView,
	UsageTotals, UsageView, Versioned,
};

pub fn changed(path: &str, status: ChangeStatus) -> ChangedFile {
	ChangedFile { path: path.into(), previous_path: None, status, additions: 1, deletions: 0 }
}

pub fn changes(revision: u64, scope: ChangeScope, file: ChangedFile) -> SnapshotSection {
	SnapshotSection::Changes(ChangesView {
		revision,
		repository: Some("/repo".into()),
		scope,
		files: vec![file],
		diff: format!("diff {revision}"),
		diff_truncated: false,
		files_withheld: 0,
	})
}

pub fn node(path: &str, kind: FileKind, depth: u32) -> FileNode {
	FileNode { path: path.into(), name: path.rsplit('/').next().unwrap_or(path).into(), kind, depth }
}

pub fn file_tree(entries: Vec<FileNode>) -> SnapshotSection {
	SnapshotSection::FileTree(FileTreeView { root: "/repo".into(), entries, truncated: false })
}

pub fn file_content(content: &str) -> SnapshotSection {
	SnapshotSection::FileContent(FileContentView {
		path:       "src/lib.rs".into(),
		content:    content.into(),
		size_bytes: content.len() as u64,
		truncated:  false,
		binary:     false,
	})
}

pub fn search(query: &str, paths: &[&str]) -> SnapshotSection {
	SnapshotSection::SearchResults(SearchResultsView {
		query:     query.into(),
		paths:     paths.iter().map(|p| (*p).to_owned()).collect(),
		truncated: false,
	})
}

pub fn content_matches(query: &str, lines: &[(&str, u32)]) -> SnapshotSection {
	SnapshotSection::ContentMatches(ContentMatchesView {
		query:     query.into(),
		matches:   lines
			.iter()
			.map(|(path, line)| ContentMatch {
				path:    (*path).to_owned(),
				line:    *line,
				preview: format!("// {query}"),
			})
			.collect(),
		truncated: false,
	})
}

pub fn terminal(id: &str, status: TerminalStatus) -> SnapshotSection {
	SnapshotSection::Terminals(vec![TerminalView {
		id: id.into(),
		cwd: "/repo".into(),
		shell: "/bin/sh".into(),
		cols: 80,
		rows: 24,
		status,
	}])
}

pub fn process(name: &str, exit_code: Option<i32>) -> SnapshotSection {
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

pub fn models(id: &str, reasoning: bool) -> SnapshotSection {
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

pub fn provider(id: &str, authenticated: bool) -> SnapshotSection {
	SnapshotSection::Providers(vec![ProviderView {
		id: id.into(),
		name: id.into(),
		authenticated,
		oauth: authenticated,
		api_key: true,
	}])
}

pub fn auth_flow(state: AuthFlowState) -> SnapshotSection {
	let done = matches!(state, AuthFlowState::Completed);
	SnapshotSection::AuthFlow(AuthFlowView {
		provider: "anthropic".into(),
		state,
		url: (!done).then(|| "https://example.com/oauth".to_owned()),
		prompt: None,
		message: done.then(|| "Success".to_owned()),
	})
}

pub fn mcp(status: McpServerStatus, tools: &[&str]) -> SnapshotSection {
	SnapshotSection::Mcp(vec![McpServerView {
		name: "fs".into(),
		enabled: true,
		status,
		tools: tools.iter().map(|t| (*t).to_owned()).collect(),
	}])
}

pub fn agent(id: &str, status: &str) -> SnapshotSection {
	SnapshotSection::Agents(vec![AgentView {
		id:           id.into(),
		call_sign:    "Kestrel".into(),
		display_name: id.into(),
		kind:         "sub".into(),
		status:       status.into(),
		parent:       None,
		scope:        "/repo".into(),
		session:      None,
		activity:     None,
		model:        None,
	}])
}

pub fn comms(body: &str) -> SnapshotSection {
	SnapshotSection::AgentComms(vec![AgentMessageView {
		id:       "m".into(),
		from:     "a".into(),
		to:       "b".into(),
		body:     body.into(),
		at_ms:    100,
		reply_to: None,
		outcome:  AgentMessageOutcome::Injected,
		error:    None,
	}])
}

pub fn usage(input_tokens: u64) -> SnapshotSection {
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

pub fn context(categories: &[(&str, u64)]) -> SnapshotSection {
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

pub fn export(format: &str) -> SnapshotSection {
	SnapshotSection::Export(ExportView {
		session: SessionId::from("sess-1"),
		format:  format.into(),
		path:    Some(format!("/repo/export.{format}")),
		content: None,
	})
}

pub fn themes(current: &str, dark: bool) -> SnapshotSection {
	SnapshotSection::Themes(ThemesView {
		themes:  vec![ThemeView { id: current.into(), name: current.into(), dark }],
		current: current.into(),
	})
}

pub fn keybinding(action: &str, key: &str) -> SnapshotSection {
	SnapshotSection::Keybindings(vec![KeybindingView {
		action: action.into(),
		keys:   vec![key.into()],
		source: "default".into(),
	}])
}

pub fn settings(entries: &[(&str, serde_json::Value)]) -> SnapshotSection {
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

pub fn command(name: &str, source: CommandSource) -> SnapshotSection {
	SnapshotSection::Commands(vec![CommandView {
		name: name.into(),
		aliases: Vec::new(),
		description: None,
		input_hint: None,
		source,
		subcommands: Vec::new(),
	}])
}

/// Two distinct sections of one kind, or `None` for a kind that does not
/// land in `Domains`. The match is exhaustive on purpose.
pub fn pair(kind: SnapshotSectionKind) -> Option<[SnapshotSection; 2]> {
	Some(match kind {
		SnapshotSectionKind::Sessions
		| SnapshotSectionKind::ActiveSession
		| SnapshotSectionKind::Transcript
		| SnapshotSectionKind::Capabilities
		| SnapshotSectionKind::Interactions
		| SnapshotSectionKind::TerminalOutput
		| SnapshotSectionKind::ProcessLogs
		// Held prompts are per-session state in `Store::queued`, not a domain view.
		| SnapshotSectionKind::QueuedPrompts
		// The freeze is process-wide state in `Store::paused`, not a domain view;
		// `crates/veyyon-desktop/tests/a-freeze-the-host-engaged-reaches-every-window.rs`
		// proves it replaces and reaches the strip.
		// Goals are per-session state in `Store::goals`, not a domain view.
		| SnapshotSectionKind::Goal
		| SnapshotSectionKind::AgentPause => return None,
		SnapshotSectionKind::SessionSearch => ["first", "second"].map(|query| {
			SnapshotSection::SessionSearch(SessionSearchView { query: query.into(), sessions: Vec::new() })
		}),
		SnapshotSectionKind::SessionTranscript => ["first", "second"].map(|session| {
			SnapshotSection::SessionTranscript(SessionTranscriptView {
				session: session.into(), transcript: Versioned { revision: 1, value: Vec::new() },
			})
		}),
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
		SnapshotSectionKind::ContentMatches => [
			content_matches("foo", &[("a.rs", 3)]),
			content_matches("bar", &[("b.rs", 9), ("c.rs", 12)]),
		],
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
		SnapshotSectionKind::Agents => [agent("agent-1", "running"), agent("agent-2", "completed")],
		SnapshotSectionKind::AgentComms => [comms("first"), comms("second")],
		SnapshotSectionKind::Usage => [usage(100), usage(500)],
		SnapshotSectionKind::ContextBreakdown => {
			[context(&[("system", 1000)]), context(&[("system", 1000), ("messages", 1500)])]
		},
		SnapshotSectionKind::Export => [export("html"), export("md")],
		SnapshotSectionKind::Themes => [themes("light", false), themes("dark", true)],
		SnapshotSectionKind::Keybindings => {
			[keybinding("app.quit", "ctrl+q"), keybinding("composer.submit", "enter")]
		},
		SnapshotSectionKind::Commands => {
			[command("compact", CommandSource::Builtin), command("review", CommandSource::Custom)]
		},
	})
}
