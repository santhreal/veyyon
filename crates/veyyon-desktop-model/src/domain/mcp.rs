use serde::{Deserialize, Serialize};

/// Connectivity and lifecycle status of an MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
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

/// What the connected MCP servers offer beyond tools: their resources, resource
/// templates and prompts, and the notifications each one sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpCatalogView {
	/// Whether the host subscribes to server notifications, as the
	/// `mcp.notifications` setting states.
	pub notifications: bool,
	/// One entry per connected server, in the order the host lists them.
	pub servers:       Vec<McpServerCatalogView>,
}

/// One connected server's resources, prompts and notification support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpServerCatalogView {
	/// The server's name.
	pub server:        String,
	/// The resources the server lists.
	pub resources:     Vec<McpResourceView>,
	/// The parameterized resources the server lists.
	pub templates:     Vec<McpResourceTemplateView>,
	/// The prompts the server lists.
	pub prompts:       Vec<McpPromptView>,
	/// The notifications the server declares it sends.
	pub notifies:      McpNotificationsView,
	/// The resource URIs the host is subscribed to on this server. Empty while
	/// notifications are off.
	pub subscriptions: Vec<String>,
}

/// A resource an MCP server lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpResourceView {
	/// The resource's URI.
	pub uri:         String,
	/// The resource's name.
	pub name:        String,
	/// The server's description of it.
	pub description: Option<String>,
	/// Its MIME type, when the server states one.
	pub mime_type:   Option<String>,
}

/// A parameterized resource an MCP server lists, as an RFC 6570 URI template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpResourceTemplateView {
	/// The URI template.
	pub uri_template: String,
	/// The template's name.
	pub name:         String,
	/// The server's description of it.
	pub description:  Option<String>,
}

/// A prompt an MCP server lists, which runs as a slash command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpPromptView {
	/// The prompt's name.
	pub name:        String,
	/// The slash command that runs it, `/<server>:<prompt>`.
	pub command:     String,
	/// The server's description of it.
	pub description: Option<String>,
	/// Its arguments, in the order the server lists them.
	pub arguments:   Vec<McpPromptArgumentView>,
}

/// One argument of an MCP prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpPromptArgumentView {
	/// The argument's name.
	pub name:        String,
	/// The server's description of it.
	pub description: Option<String>,
	/// Whether the prompt fails without it.
	pub required:    bool,
}

/// The notifications an MCP server declares in its capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpNotificationsView {
	/// The server announces a changed tool list.
	pub tools_changed:     bool,
	/// The server announces a changed resource list.
	pub resources_changed: bool,
	/// The server announces a changed prompt list.
	pub prompts_changed:   bool,
	/// The server offers resources at all.
	pub offers_resources:  bool,
	/// The server accepts subscriptions to a resource's updates.
	pub subscribe:         bool,
}

/// The outcome of connecting to a server once, apart from its running
/// connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpProbeView {
	/// The server's configured name.
	pub server:  String,
	/// What the connection found.
	pub outcome: McpProbeOutcome,
}

/// What a one-off connection to an MCP server found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum McpProbeOutcome {
	/// The server completed the handshake and listed its tools.
	Connected {
		/// The name the server reports for itself.
		name:    String,
		/// The version the server reports.
		version: String,
		/// The tools it lists.
		tools:   Vec<String>,
	},
	/// The connection or the tool listing failed.
	Failed {
		/// The failure, as the transport or the server reported it.
		message: String,
	},
}

/// The Smithery registry as this profile reaches it: whether a key is stored,
/// and the results of the last search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpRegistryView {
	/// Whether a Smithery API key is stored for this profile or set in the
	/// host's environment.
	pub signed_in: bool,
	/// The words the last search was for, or None before any search.
	pub query:     Option<String>,
	/// The last search's results, best first.
	pub results:   Vec<McpRegistryResultView>,
}

/// One server the registry returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpRegistryResultView {
	/// The result's id, which `DeployMcpRegistryServer` names.
	pub id:          String,
	/// The registry's display name.
	pub name:        String,
	/// The registry's description.
	pub description: String,
	/// How the server is reached: `http` or `stdio`.
	pub transport:   String,
	/// How many times the registry reports it used.
	pub use_count:   u64,
	/// Whether the registry verified the publisher.
	pub verified:    bool,
	/// The name it is added under unless another is given: its registry name,
	/// suffixed until no server in the profile's config holds it.
	pub server:      String,
	/// What the registry flagged about the entry.
	pub warnings:    Vec<String>,
	/// The values the server's configuration asks for.
	pub inputs:      Vec<McpRegistryInputView>,
}

/// One value a registry server's configuration asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct McpRegistryInputView {
	/// The key `DeployMcpRegistryServer` names it by.
	pub key:         String,
	/// The label to draw beside the field.
	pub label:       String,
	/// The registry's description of it.
	pub description: Option<String>,
	/// Whether deploying fails without it.
	pub required:    bool,
	/// The value used when none is given.
	pub default:     Option<String>,
	/// Whether the value is a secret the field masks.
	pub sensitive:   bool,
	/// The values it accepts, or empty for free text.
	pub choices:     Vec<String>,
}
