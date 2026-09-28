//! One pair per section kind, which is what a sweep over the section vocabulary
//! reduces: two values of the same kind that differ in what they carry.

use veyyon_desktop_model::{
	AuthFlowState, ChangeScope, ChangeStatus, CommandSource, FileKind, McpServerStatus,
	SessionSearchView, SessionTranscriptView, SnapshotSection, SnapshotSectionKind, TerminalStatus,
	Versioned,
	domain::{
		CredentialKind, ExportFormat, ExtensionItemView, ExtensionKind, ExtensionLevel,
		ExtensionSourceView, ExtensionState, ExtensionsView, StoredAccountView,
	},
};

use super::{
	agent, auth_flow, autoswarm, changed, changes, command, comms, content_matches, context, export,
	extension_ui::{completions, extension_ui},
	file_content, file_tree, foreground, keybinding, mcp,
	mcp_views::{catalog, probe, registry},
	models, node, process, profiles, prompt_history, provider, search, settings,
	status::{checkout, host, pace, quota, serving},
	terminal, themes, todo,
	tree::session_tree,
	usage,
};

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
		// An edit queues behind the ones the composer has not taken, by
		// design, and a notice goes on the announcement stack; each has its
		// own suite in `extension-chrome-edits-and-completions-reach-the-store.rs`.
		| SnapshotSectionKind::ComposerEdit
		| SnapshotSectionKind::ExtensionNotice
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
		SnapshotSectionKind::PromptHistory => [
			prompt_history("foo", &[(1, "run the foo pass")]),
			prompt_history("bar", &[(2, "run the bar pass"), (3, "undo the bar pass")]),
		],
		SnapshotSectionKind::ForegroundCommand => [
			foreground("s1", Some("bun test")),
			// The second states the wait settled, which is the replacement
			// that matters: a merge would keep drawing the finished command.
			foreground("s1", None),
		],
		SnapshotSectionKind::AutoswarmConsole => [
			autoswarm("s1", Some("p50 latency")),
			// The console closes, which drops the ledger with it: a merge
			// would keep drawing runs of a console nothing has open.
			autoswarm("s1", None),
		],
		SnapshotSectionKind::Todo => [
			todo("s1", Some("Publish the board at each todo result")),
			// The board empties, which drops the card with it: a merge would
			// keep drawing a phase of a plan the session no longer records.
			todo("s1", None),
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
		SnapshotSectionKind::Export => [export(ExportFormat::Html), export(ExportFormat::Json)],
		SnapshotSectionKind::Themes => [themes("light", false), themes("dark", true)],
		SnapshotSectionKind::Keybindings => {
			[keybinding("app.quit", "ctrl+q"), keybinding("composer.submit", "enter")]
		},
		SnapshotSectionKind::Commands => {
			[command("compact", CommandSource::Builtin), command("review", CommandSource::Custom)]
		},
		SnapshotSectionKind::Profiles => {
			[profiles("default", &["default"]), profiles("default", &["default", "work"])]
		},
		SnapshotSectionKind::Share => [
			SnapshotSection::Share(veyyon_desktop_model::ShareView {
				state: "off".into(),
				role: veyyon_desktop_model::ShareRole::Off,
				guest: None,
				relay_url: Some("https://relay.example.com".into()),
				link: None,
				web_link: None,
				view_link: None,
				web_view_link: None,
				participants: Vec::new(),
				error: None,
			}),
			SnapshotSection::Share(veyyon_desktop_model::ShareView {
				state: "hosting".into(),
				role: veyyon_desktop_model::ShareRole::Hosting,
				guest: None,
				relay_url: Some("https://relay.example.com".into()),
				link: Some("https://relay.example.com/r1".into()),
				web_link: Some("https://relay.example.com/web/r1".into()),
				view_link: Some("https://relay.example.com/r1?ro=1".into()),
				web_view_link: Some("https://relay.example.com/web/r1?ro=1".into()),
				participants: vec![veyyon_desktop_model::ShareParticipantView {
					id: 0,
					name: "HostNode".into(),
					can_write: true,
					is_host: true,
				}],
				error: None,
			}),
		],
		// One phrase in flight, then that phrase committed and the microphone
		// closed: the second carries an empty `partial`, so a reducer that
		// merged rather than replaced would still be drawing the first's.
		SnapshotSectionKind::Dictation => [
			SnapshotSection::Dictation(veyyon_desktop_model::DictationView {
				state:     veyyon_desktop_model::DictationState::Recording,
				utterance: "ship the desktop".into(),
				partial:   " parity work".into(),
				submit:    false,
				status:    None,
				error:     None,
				revision:  1,
			}),
			SnapshotSection::Dictation(veyyon_desktop_model::DictationView {
				state:     veyyon_desktop_model::DictationState::Idle,
				utterance: "ship the desktop parity work".into(),
				partial:   String::new(),
				submit:    true,
				status:    None,
				error:     None,
				revision:  2,
			}),
		],
		SnapshotSectionKind::Accounts => [account(1, "work"), account(2, "home")],
		SnapshotSectionKind::Extensions => [extensions(true), extensions(false)],
		SnapshotSectionKind::Host => [host("studio.local"), host("build-01.example.net")],
		// A branch then the same session on another branch with a pull request
		// open, so a reducer that kept the first pull request is caught.
		SnapshotSectionKind::Checkout => {
			[checkout("s1", Some("main"), None), checkout("s1", Some("feat/gui"), Some(42))]
		},
		// Idle after one finished window, then working again: the second
		// carries a running window and a rate the first lacks.
		SnapshotSectionKind::Pace => [pace("s1", 12_000, None), pace("s1", 12_000, Some(1_000))],
		SnapshotSectionKind::ServingAccount => {
			[serving("s1", Some("work")), serving("s1", Some("home"))]
		},
		SnapshotSectionKind::Quota => [quota("s1", Some(805)), quota("s1", Some(120))],
		// A subscription then none, a pass then a failure, one query then
		// another: a reducer that merged rather than replaced keeps the first.
		SnapshotSectionKind::McpCatalog => [catalog(&["docs://readme"]), catalog(&[])],
		SnapshotSectionKind::McpProbe => [probe(Some(&["search"])), probe(None)],
		SnapshotSectionKind::McpRegistry => [registry("search"), registry("files")],
		// A status then another; a completion answer then the next query's.
		SnapshotSectionKind::ExtensionUi => {
			[extension_ui("s1", "lint: 2 warnings"), extension_ui("s1", "lint: clean")]
		},
		SnapshotSectionKind::ComposerCompletions => {
			[completions("s1", 1, "#issue-42"), completions("s1", 2, "#issue-7")]
		},
		// A navigation moves the leaf, then a label lands on the prompt: a
		// reducer that kept the first tree keeps the old leaf and no label.
		SnapshotSectionKind::SessionTree => {
			[session_tree("s1", "e2", None), session_tree("s1", "e1", Some("checkpoint"))]
		},
	})
}

fn account(credential_id: u64, label: &str) -> SnapshotSection {
	SnapshotSection::Accounts(vec![StoredAccountView {
		provider: "anthropic".into(),
		credential_id,
		label: label.into(),
		kind: CredentialKind::Oauth,
		selected: true,
	}])
}

/// One skill from one source, loaded while the source is on and withheld
/// once it is switched off.
fn extensions(source_enabled: bool) -> SnapshotSection {
	SnapshotSection::Extensions(ExtensionsView {
		sources: vec![ExtensionSourceView {
			id:      "claude".into(),
			name:    "Claude Code".into(),
			enabled: source_enabled,
		}],
		items:   vec![ExtensionItemView {
			id:          "skill:review".into(),
			kind:        ExtensionKind::Skill,
			name:        "review".into(),
			description: None,
			trigger:     None,
			path:        "/home/.claude/skills/review/SKILL.md".into(),
			source:      "claude".into(),
			level:       ExtensionLevel::User,
			state:       if source_enabled {
				ExtensionState::Active
			} else {
				ExtensionState::SourceDisabled
			},
			shadowed_by: None,
		}],
	})
}
