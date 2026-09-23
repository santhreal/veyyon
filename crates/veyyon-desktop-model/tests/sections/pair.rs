//! One pair per section kind, which is what a sweep over the section vocabulary
//! reduces: two values of the same kind that differ in what they carry.

use veyyon_desktop_model::{
	AuthFlowState, ChangeScope, ChangeStatus, CommandSource, FileKind, McpServerStatus,
	SessionSearchView, SessionTranscriptView, SnapshotSection, SnapshotSectionKind, TerminalStatus,
	Versioned,
};

use super::{
	agent, auth_flow, changed, changes, command, comms, content_matches, context, export,
	file_content, file_tree, keybinding, mcp, models, node, process, profiles, provider, search,
	settings, terminal, themes, usage,
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
		SnapshotSectionKind::Profiles => {
			[profiles("default", &["default"]), profiles("default", &["default", "work"])]
		},
		SnapshotSectionKind::Share => [
			SnapshotSection::Share(veyyon_desktop_model::ShareView {
				state: "off".into(),
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
	})
}
