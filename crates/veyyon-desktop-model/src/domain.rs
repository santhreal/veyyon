use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{connection::SessionId, transcript::UsageTotals};

/// Scope of uncommitted git working tree modifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeScope {
	/// Modified and untracked files in the working tree.
	WorkingTree,
	/// Staged changes in the git index.
	Staged,
}

/// Status classification for a modified path within a git repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeStatus {
	/// Newly added file.
	Added,
	/// Modified existing file.
	Modified,
	/// Deleted file.
	Deleted,
	/// Renamed or moved file path.
	Renamed,
	/// Untracked file not yet in index or git history.
	Untracked,
	/// Unresolved merge conflict file.
	Conflicted,
}

/// Detailed file modification metadata within a git changes snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
	/// Workspace-relative path to the file.
	pub path:          String,
	/// Previous workspace-relative path if renamed.
	pub previous_path: Option<String>,
	/// Git modification status.
	pub status:        ChangeStatus,
	/// Number of added lines.
	pub additions:     u64,
	/// Number of deleted lines.
	pub deletions:     u64,
}

/// View of uncommitted repository changes and unified diff text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangesView {
	/// Revision counter tracking change snapshot order.
	pub revision:   u64,
	/// Root path of the owning git repository.
	pub repository: Option<String>,
	/// Scope filter applied to this changes snapshot.
	pub scope:      ChangeScope,
	/// Individual changed files in this snapshot.
	pub files:      Vec<ChangedFile>,
	/// Unified diff string spanning all changed files for this scope.
	pub diff:       String,
}

/// Filesystem node kind within a workspace directory tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileKind {
	/// Regular file.
	File,
	/// Directory container.
	Directory,
	/// Symbolic link.
	Symlink,
}

/// Individual node within a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileNode {
	/// Workspace-relative path separated with forward slashes.
	pub path:  String,
	/// Node base name without parent path components.
	pub name:  String,
	/// Filesystem node classification.
	pub kind:  FileKind,
	/// Nesting depth from the tree root.
	pub depth: u32,
}

/// Workspace filesystem directory hierarchy view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTreeView {
	/// Root directory path.
	pub root:      String,
	/// Flattened list of file and directory nodes.
	pub entries:   Vec<FileNode>,
	/// Flag indicating whether the listing was truncated due to size limits.
	pub truncated: bool,
}

/// File content snapshot payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContentView {
	/// Workspace-relative path of the requested file.
	pub path:       String,
	/// Text content of the file.
	pub content:    String,
	/// Size of the file in bytes.
	pub size_bytes: u64,
	/// Flag indicating whether content was truncated due to buffer limits.
	pub truncated:  bool,
	/// Flag indicating whether the file contains binary data.
	pub binary:     bool,
}

/// Text search match results across workspace files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResultsView {
	/// Query text or pattern matched.
	pub query:     String,
	/// Workspace-relative matching file paths.
	pub paths:     Vec<String>,
	/// Flag indicating whether results were truncated due to match limits.
	pub truncated: bool,
}

/// Execution status of a managed terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalStatus {
	/// Terminal process is active and running.
	Running,
	/// Terminal process exited normally or with a non-zero code.
	Exited {
		/// Process exit code.
		code: i32,
	},
	/// Terminal process failed to spawn or crashed unexpectedly.
	Failed {
		/// Error message describing the failure.
		message: String,
	},
}

/// Managed terminal instance metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalView {
	/// Unique terminal identifier.
	pub id:     String,
	/// Working directory of the terminal process.
	pub cwd:    String,
	/// Shell executable path.
	pub shell:  String,
	/// Column count of the terminal grid.
	pub cols:   u32,
	/// Row count of the terminal grid.
	pub rows:   u32,
	/// Operational state of the terminal.
	pub status: TerminalStatus,
}

/// Incremental terminal output byte stream chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOutputChunk {
	/// Terminal identifier producing the output.
	pub terminal: String,
	/// Monotonic sequence number for ordering and gap detection.
	pub seq:      u64,
	/// Raw ANSI/UTF-8 output bytes.
	pub data:     Vec<u8>,
	/// When true, clears previous scrollback buffer and resets sequence
	/// tracking.
	pub reset:    bool,
}

/// Supervised child process metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessView {
	/// Process display name.
	pub name:          String,
	/// Operating system process ID if currently running.
	pub pid:           Option<u32>,
	/// Status summary string (e.g., "running", "exited").
	pub status:        String,
	/// Executable or application command name.
	pub application:   String,
	/// Command line argument list.
	pub args:          Vec<String>,
	/// Working directory of the process.
	pub cwd:           String,
	/// Process lifetime policy.
	pub lifetime:      String,
	/// Unix timestamp in milliseconds when the process was started.
	pub started_at_ms: u64,
	/// Exit status code if the process completed.
	pub exit_code:     Option<i32>,
	/// Termination initiator or reason if stopped.
	pub terminated_by: Option<String>,
}

/// Incremental log line chunk from a supervised process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogsChunk {
	/// Name of the process producing log lines.
	pub process: String,
	/// Log line text items.
	pub lines:   Vec<String>,
	/// Host log cursor position.
	pub cursor:  u64,
	/// When true, clears previous log buffer.
	pub reset:   bool,
}

/// Reference identifying a provider and model pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
	/// Provider identifier (e.g. "anthropic", "openai").
	pub provider: String,
	/// Model identifier.
	pub id:       String,
}

/// Detailed model capabilities and token window bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelView {
	/// Provider identifier.
	pub provider:       String,
	/// Model identifier.
	pub id:             String,
	/// Human-readable model display name.
	pub name:           String,
	/// Flag indicating whether the model supports extended reasoning.
	pub reasoning:      bool,
	/// Maximum context window size in tokens.
	pub context_window: u64,
	/// Maximum generation output limit in tokens.
	pub max_output:     u64,
}

/// Available models, current model selection, and thinking configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelsView {
	/// List of all available models.
	pub models:          Vec<ModelView>,
	/// Currently selected model reference.
	pub current:         Option<ModelRef>,
	/// Active thinking or reasoning effort level.
	pub thinking_level:  Option<String>,
	/// Supported thinking effort levels for the current model.
	pub thinking_levels: Vec<String>,
}

/// Model provider account and authentication state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderView {
	/// Unique provider identifier.
	pub id:            String,
	/// Human-readable provider name.
	pub name:          String,
	/// Flag indicating whether valid credentials exist.
	pub authenticated: bool,
	/// Flag indicating whether OAuth flow is supported.
	pub oauth:         bool,
	/// Flag indicating whether API key authentication is supported.
	pub api_key:       bool,
}

/// Interactive OAuth authentication flow phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthFlowState {
	/// Awaiting browser authorization from the user.
	AwaitingBrowser,
	/// Awaiting secret or authorization code input.
	AwaitingSecret,
	/// Authentication completed successfully.
	Completed,
	/// Authentication failed with an error.
	Failed,
	/// Authentication was cancelled.
	Cancelled,
}

/// Active OAuth authentication flow progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthFlowView {
	/// Provider identifier undergoing authentication.
	pub provider: String,
	/// Current state of the flow.
	pub state:    AuthFlowState,
	/// Authorization URL for browser navigation.
	pub url:      Option<String>,
	/// Prompt text instructing the user on required input.
	pub prompt:   Option<String>,
	/// Status or error message.
	pub message:  Option<String>,
}

/// Connectivity and lifecycle status of an MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpServerStatus {
	/// Server is connected and tools are active.
	Connected,
	/// Server handshake is in progress.
	Connecting,
	/// Server is disconnected or stopped.
	Disconnected,
	/// Server encountered an error.
	Error {
		/// Error detail message.
		message: String,
	},
}

/// Configured Model Context Protocol server configuration and tool list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerView {
	/// Server identifier name.
	pub name:    String,
	/// Flag indicating whether the server is enabled.
	pub enabled: bool,
	/// Current server connection status.
	pub status:  McpServerStatus,
	/// List of exposed tool names.
	pub tools:   Vec<String>,
}

/// Result of an ad-hoc or direct MCP tool execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolResultView {
	/// Name of the executing MCP server.
	pub server:   String,
	/// Name of the invoked tool.
	pub tool:     String,
	/// Flag indicating whether tool execution failed.
	pub is_error: bool,
	/// Output payload or error text.
	pub output:   String,
}

/// Background or worker subagent execution metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentView {
	/// Unique agent identifier.
	pub id:           String,
	/// Human-readable agent display name.
	pub display_name: String,
	/// Agent role or kind.
	pub kind:         String,
	/// Operational state.
	pub status:       String,
	/// Parent agent identifier if nested.
	pub parent:       Option<String>,
	/// Working directory or scope path.
	pub scope:        String,
	/// Owning session identifier if tied to a session.
	pub session:      Option<SessionId>,
}

/// Token usage category item in a context window breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextCategory {
	/// Category name (e.g., "system", "messages", "tools").
	pub name:   String,
	/// Token count occupied by this category.
	pub tokens: u64,
}

/// Token breakdown of the active session context window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextBreakdownView {
	/// Owning session identifier.
	pub session:      SessionId,
	/// Total tokens currently consumed.
	pub total_tokens: u64,
	/// Maximum context window token ceiling if known.
	pub limit_tokens: Option<u64>,
	/// Breakdown of tokens by category.
	pub categories:   Vec<ContextCategory>,
}

/// Session resource and financial cost accounting totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageView {
	/// Owning session identifier.
	pub session: SessionId,
	/// Aggregated token counts and costs.
	pub totals:  UsageTotals,
}

/// Transcript export result or file path snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportView {
	/// Exported session identifier.
	pub session: SessionId,
	/// Export format (e.g., "html", "markdown", "json").
	pub format:  String,
	/// Path where the export file was written, if saved to disk.
	pub path:    Option<String>,
	/// Direct exported content string if returned in memory.
	pub content: Option<String>,
}

/// Single visual color theme definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeView {
	/// Unique theme identifier.
	pub id:   String,
	/// Display name.
	pub name: String,
	/// Flag indicating whether this is a dark theme.
	pub dark: bool,
}

/// Available themes and currently active theme identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemesView {
	/// List of all installed themes.
	pub themes:  Vec<ThemeView>,
	/// Identifier of the currently active theme.
	pub current: String,
}

/// Keyboard shortcut binding configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingView {
	/// Target action name triggered by this binding.
	pub action: String,
	/// Key sequence combination strings (e.g. `["ctrl+enter"]`).
	pub keys:   Vec<String>,
	/// Configuration source (e.g. "default", "user").
	pub source: String,
}

/// Sequence gap recorded when chunks arrive out of order or with dropped
/// frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeqGap {
	/// Expected sequence number.
	pub expected: u64,
	/// Actually received sequence number.
	pub received: u64,
}

/// Maximum scrollback buffer capacity per terminal (1 MiB).
pub const TERMINAL_SCROLLBACK_CAPACITY_BYTES: usize = 1024 * 1024;

/// Bounded byte scrollback buffer for a single terminal instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalScrollback {
	/// Bounded byte buffer of terminal scrollback data.
	pub data:     Vec<u8>,
	/// Last received chunk sequence number.
	pub last_seq: Option<u64>,
	/// Recorded sequence gap events when chunks arrive out of order.
	pub gaps:     Vec<SeqGap>,
}

impl Default for TerminalScrollback {
	fn default() -> Self {
		Self::new()
	}
}

impl TerminalScrollback {
	/// Creates an empty scrollback buffer.
	#[must_use]
	pub const fn new() -> Self {
		Self { data: Vec::new(), last_seq: None, gaps: Vec::new() }
	}

	/// Appends an incoming chunk to the scrollback buffer, handling resets, gap
	/// detection, and capacity bounds.
	pub fn append_chunk(&mut self, chunk: TerminalOutputChunk) {
		if chunk.reset {
			self.data.clear();
			self.gaps.clear();
			self.last_seq = Some(chunk.seq);
			self.data = chunk.data;
		} else {
			if let Some(prev) = self.last_seq
				&& chunk.seq != prev.saturating_add(1)
			{
				self
					.gaps
					.push(SeqGap { expected: prev.saturating_add(1), received: chunk.seq });
			}
			self.last_seq = Some(chunk.seq);
			self.data.extend(chunk.data);
		}

		if self.data.len() > TERMINAL_SCROLLBACK_CAPACITY_BYTES {
			let overflow = self.data.len() - TERMINAL_SCROLLBACK_CAPACITY_BYTES;
			self.data.drain(..overflow);
		}
	}
}

/// Maximum number of log lines retained per supervised process.
pub const PROCESS_LOG_CAPACITY_LINES: usize = 10_000;

/// Bounded log output buffer for a supervised process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogView {
	/// Retained log lines.
	pub lines:  Vec<String>,
	/// Current cursor index.
	pub cursor: u64,
}

impl Default for ProcessLogView {
	fn default() -> Self {
		Self::new()
	}
}

impl ProcessLogView {
	/// Creates an empty process log buffer.
	#[must_use]
	pub const fn new() -> Self {
		Self { lines: Vec::new(), cursor: 0 }
	}

	/// Appends an incoming log chunk, updating lines, cursor, and enforcing the
	/// capacity bound.
	pub fn append_chunk(&mut self, chunk: ProcessLogsChunk) {
		if chunk.reset {
			self.lines.clear();
		}
		self.cursor = chunk.cursor;
		self.lines.extend(chunk.lines);
		if self.lines.len() > PROCESS_LOG_CAPACITY_LINES {
			let overflow = self.lines.len() - PROCESS_LOG_CAPACITY_LINES;
			self.lines.drain(..overflow);
		}
	}
}

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
	/// Raw configuration settings payload.
	pub settings:        Option<serde_json::Value>,
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
