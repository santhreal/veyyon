//! Domain-specific snapshot and state payload models (§5, §8).

pub mod history;
pub use history::*;

pub mod agents;
pub mod answered;
pub mod autoswarm;
pub mod changes;
pub mod commands;
pub mod diagnostics;
pub mod dictation;
pub mod files;
pub mod foreground;
pub mod goal;
pub mod mcp;
pub mod models;
pub mod pause;
pub mod process;
pub mod profiles;
pub mod providers;
pub mod queued;
pub mod settings;
pub mod share;
pub mod terminal;
pub mod themes;
pub mod todo;
pub mod usage;

use std::collections::HashMap;

pub use agents::*;
pub use answered::*;
pub use autoswarm::*;
pub use changes::*;
pub use commands::*;
pub use diagnostics::*;
pub use dictation::*;
pub use files::*;
pub use foreground::*;
pub use goal::*;
pub use mcp::*;
pub use models::*;
pub use pause::*;
pub use process::*;
pub use profiles::*;
pub use providers::*;
pub use queued::*;
use serde::{Deserialize, Serialize};
pub use settings::*;
pub use share::*;
pub use terminal::*;
pub use themes::*;
pub use todo::*;
pub use usage::*;

use crate::{connection::SessionId, transcript::UsageTotals};

/// Container for all panel-domain views received from the host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Domains {
	/// Latest search response; its query prevents stale results from being
	/// drawn.
	pub session_search:  Option<SessionSearchView>,
	/// One read-only preview, separate from every live transcript.
	pub session_preview: Option<SessionTranscriptView>,
	/// Uncommitted repository changes. The panel parses this into rows, so it
	/// states how many answers have arrived and the projection holds the rows
	/// it built until that count moves.
	pub changes:         Answered<ChangesView>,
	/// Workspace directory file tree.
	pub file_tree:       Option<FileTreeView>,
	/// File content snapshot. Highlighted line by line, so it counts its
	/// answers for the same reason `changes` does.
	pub file_content:    Answered<FileContentView>,
	/// Text search results.
	pub search:          Option<SearchResultsView>,
	/// The lines the host's last content search matched.
	pub content_matches: Option<ContentMatchesView>,
	/// The prompts the host's last history lookup matched.
	pub prompt_history:  Option<PromptHistoryView>,
	/// Managed terminal instances.
	pub terminals:       Vec<TerminalView>,
	/// Terminal scrollback buffers indexed by terminal ID.
	pub terminal_output: HashMap<String, TerminalScrollback>,
	/// Supervised background processes.
	pub processes:       Vec<ProcessView>,
	/// Process log buffers indexed by process name.
	pub process_logs:    HashMap<String, ProcessLogView>,
	/// Model catalog and active model selection.
	pub models:          Option<ModelsView>,
	/// Configured AI providers.
	pub providers:       Vec<ProviderView>,
	/// Active OAuth authentication flow.
	pub auth_flow:       Option<AuthFlowView>,
	/// Model Context Protocol servers.
	pub mcp:             Vec<McpServerView>,
	/// Active background subagents.
	pub agents:          Vec<AgentView>,
	/// Agent-to-agent IRC comms message stream.
	pub agent_comms:     Vec<AgentMessageView>,
	/// Session resource and token usage totals.
	pub usage:           HashMap<SessionId, UsageTotals>,
	/// Context window breakdown indexed by session.
	pub context:         HashMap<SessionId, ContextBreakdownView>,
	/// Transcript export snapshot, which holds the File tab while no file is
	/// open and is highlighted the same way, so it counts its answers too.
	pub export:          Answered<ExportView>,
	/// UI color themes.
	pub themes:          Option<ThemesView>,
	/// Keyboard shortcuts.
	pub keybindings:     Vec<KeybindingView>,
	/// The slash commands the host advertises, in the order it sent them.
	pub commands:        Vec<CommandView>,
	/// Every setting the host reports, keyed by schema key.
	pub settings:        Option<SettingsView>,
	/// Diagnostic sources payload.
	pub diagnostics:     Option<serde_json::Value>,
	/// Relay session sharing status and link bundle.
	pub share:           Option<ShareView>,
	/// The profiles on disk, and where each one's host is.
	pub profiles:        Option<ProfilesView>,
	/// The speech this window is dictating, absent until it dictates.
	pub dictation:       Option<DictationView>,
	/// The command each session is waiting on in the foreground, keyed by
	/// session. A session waiting on none holds no entry.
	pub foreground:      HashMap<SessionId, ForegroundCommandView>,
	/// The autoswarm console each session has open, keyed by session. A
	/// session with none open holds no entry, which is what lets the surface
	/// be drawn from the entry's presence.
	pub autoswarm:       HashMap<SessionId, AutoswarmConsoleView>,
	/// The plan each session is working, keyed by session. A session whose
	/// board holds no task holds no entry, so the card is drawn from the
	/// entry's presence and never from an empty board.
	pub todo:            HashMap<SessionId, TodoBoardView>,
}

impl Domains {
	/// Creates an initialized domains container with empty sub-views.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}
}
