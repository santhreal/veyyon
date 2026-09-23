//! Two sections of each domain the host sends, differing in what they carry,
//! so a suite can reduce one after the other and read what is left.
//!
//! These state the protocol's shape rather than the invariant under test, so
//! they sit beside the suite that sweeps them instead of inside it.

mod pair;

use veyyon_desktop_model::{
	AgentMessageOutcome, AgentMessageView, AgentView, AuthFlowState, AuthFlowView, ChangeScope,
	ChangeStatus, ChangedFile, ChangesView, CommandSource, CommandView, ContentMatch,
	ContentMatchesView, ContextBreakdownView, ContextCategory, ExportView, FileContentView,
	FileKind, FileNode, FileTreeView, InputModality, KeybindingView, McpServerStatus, McpServerView,
	ModelRef, ModelView, ModelsView, ProcessView, ProfileCopyItemView, ProfileView, ProfilesView,
	ProviderView, SearchResultsView, SessionId, SettingEntry, SettingKind, SettingsView,
	SnapshotSection, TerminalStatus, TerminalView, ThemeView, ThemesView, UsageTotals, UsageView,
};

pub use self::pair::pair;

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
		themes: vec![ThemeView { id: current.into(), name: current.into(), dark }],
		dark:   if dark {
			current.into()
		} else {
			"titanium".to_owned()
		},
		light:  if dark {
			"light".to_owned()
		} else {
			current.into()
		},
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

pub fn profiles(active: &str, names: &[&str]) -> SnapshotSection {
	SnapshotSection::Profiles(ProfilesView {
		active:     active.into(),
		entries:    names
			.iter()
			.map(|name| ProfileView {
				name:           (*name).to_owned(),
				display_name:   (*name).to_owned(),
				root_dir:       format!("/home/dev/.veyyon/profiles/{name}"),
				endpoint:       Some(format!(
					"unix:/home/dev/.veyyon/profiles/{name}/agent/gui-host.sock"
				)),
				endpoint_error: None,
				is_active:      *name == active,
			})
			.collect(),
		copy_items: vec![ProfileCopyItemView {
			key:         "agents".into(),
			label:       "AGENTS.md".into(),
			description: "Profile-specific agent instructions".into(),
		}],
	})
}
