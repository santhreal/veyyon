//! MCP server filtering and capability summaries.

use veyyon_gui_core::model::{McpConnectionPhase, McpServerId, McpServerView, McpState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualWindow {
	pub first: usize,
	pub rows:  usize,
}

pub fn matches(server: &McpServerView, query: &str) -> bool {
	let query = query.trim().to_lowercase();
	query.is_empty()
		|| server.name.to_lowercase().contains(&query)
		|| server.id.as_str().to_lowercase().contains(&query)
		|| server.source.to_lowercase().contains(&query)
}

pub fn filtered<'a>(
	state: &'a McpState,
	query: &str,
	window: VirtualWindow,
) -> Vec<&'a McpServerView> {
	state
		.servers
		.readable()
		.into_iter()
		.flatten()
		.filter(|server| matches(server, query))
		.skip(window.first)
		.take(window.rows)
		.collect()
}

pub fn selected<'a>(state: &'a McpState, id: &McpServerId) -> Option<&'a McpServerView> {
	state
		.servers
		.readable()?
		.iter()
		.find(|server| &server.id == id)
}

pub fn status_label(phase: &McpConnectionPhase) -> &'static str {
	match phase {
		McpConnectionPhase::Disabled => "Disabled",
		McpConnectionPhase::Disconnected => "Disconnected",
		McpConnectionPhase::Connecting => "Connecting",
		McpConnectionPhase::Connected => "Connected",
		McpConnectionPhase::AuthenticationRequired => "Authentication required",
		McpConnectionPhase::Failed => "Connection failed",
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityCounts {
	pub tools:     usize,
	pub resources: usize,
	pub prompts:   usize,
}

pub fn capability_counts(server: &McpServerView) -> CapabilityCounts {
	CapabilityCounts {
		tools:     server.tools.len(),
		resources: server.resources.len(),
		prompts:   server.prompts.len(),
	}
}
