//! MCP server, extension, command, skill, and custom-tool replicas.

use super::{ExtensionId, McpServerId, ProviderId, RemoteData, Value};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum McpTransport {
	Stdio,
	Http,
	Sse,
	Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum McpConnectionPhase {
	Disabled,
	Disconnected,
	Connecting,
	Connected,
	AuthenticationRequired,
	Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpToolView {
	pub name:         String,
	pub description:  Option<String>,
	pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpResourceView {
	pub uri:        String,
	pub name:       String,
	pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpPromptView {
	pub name:        String,
	pub description: Option<String>,
	pub arguments:   Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpServerView {
	pub id:             McpServerId,
	pub name:           String,
	pub source:         String,
	pub transport:      McpTransport,
	pub enabled:        bool,
	pub phase:          McpConnectionPhase,
	pub error:          Option<String>,
	pub implementation: Option<String>,
	pub capabilities:   Vec<String>,
	pub tools:          Vec<McpToolView>,
	pub resources:      Vec<McpResourceView>,
	pub prompts:        Vec<McpPromptView>,
	pub auth_required:  Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct McpState {
	pub servers: RemoteData<Vec<McpServerView>>,
	pub startup: Vec<(McpServerId, McpConnectionPhase)>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SlashCommandView {
	pub name:        String,
	pub aliases:     Vec<String>,
	pub description: String,
	pub input_hint:  Option<String>,
	pub subcommands: Vec<String>,
	pub source:      String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExtensionView {
	pub id:      ExtensionId,
	pub name:    String,
	pub source:  String,
	pub enabled: bool,
	pub status:  Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExtensionLoadFailure {
	pub source:  String,
	pub message: String,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiscoveredCapabilityView {
	pub id:          String,
	pub name:        String,
	pub source:      String,
	pub description: Option<String>,
	pub enabled:     bool,
	pub status:      Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ExtensionRegistryState {
	pub extensions:             Vec<ExtensionView>,
	pub plugins:                Vec<ExtensionView>,
	pub commands:               Vec<SlashCommandView>,
	pub skills:                 Vec<DiscoveredCapabilityView>,
	pub tools:                  Vec<DiscoveredCapabilityView>,
	pub load_failures:          Vec<ExtensionLoadFailure>,
	pub provider_contributions: Vec<ProviderId>,
}
