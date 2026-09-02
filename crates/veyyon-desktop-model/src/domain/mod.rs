//! Domain-specific snapshot and state payload models (§5, §8).

pub mod agents;
pub mod changes;
pub mod files;
pub mod mcp;
pub mod models;
pub mod process;
pub mod providers;
pub mod settings;
pub mod terminal;
pub mod themes;
pub mod usage;

use std::collections::HashMap;

pub use agents::*;
pub use changes::*;
pub use files::*;
pub use mcp::*;
pub use models::*;
pub use process::*;
pub use providers::*;
use serde::{Deserialize, Serialize};
pub use settings::*;
pub use terminal::*;
pub use themes::*;
pub use usage::*;

use crate::{connection::SessionId, transcript::UsageTotals};

/// Container for all panel-domain views received from the host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Domains {
	/// Uncommitted repository changes.
	pub changes:         Option<ChangesView>,
	/// Workspace directory file tree.
	pub file_tree:       Option<FileTreeView>,
	/// File content snapshot.
	pub file_content:    Option<FileContentView>,
	/// Text search results.
	pub search:          Option<SearchResultsView>,
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
	/// Ad-hoc MCP tool execution result.
	pub mcp_tool_result: Option<McpToolResultView>,
	/// Active background subagents.
	pub agents:          Vec<AgentView>,
	/// Session resource and token usage totals.
	pub usage:           HashMap<SessionId, UsageTotals>,
	/// Context window breakdown indexed by session.
	pub context:         HashMap<SessionId, ContextBreakdownView>,
	/// Transcript export snapshot.
	pub export:          Option<ExportView>,
	/// UI color themes.
	pub themes:          Option<ThemesView>,
	/// Keyboard shortcuts.
	pub keybindings:     Vec<KeybindingView>,
	/// Every setting the host reports, keyed by schema key.
	pub settings:        Option<SettingsView>,
	/// Diagnostic sources payload.
	pub diagnostics:     Option<serde_json::Value>,
}

impl Domains {
	/// Creates an initialized domains container with empty sub-views.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}
}
