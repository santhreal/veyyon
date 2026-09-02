use serde::{Deserialize, Serialize};

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
