//! The MCP sections beyond the server list: what the connected servers offer,
//! a test's outcome and the Smithery registry.

use veyyon_desktop_model::{
	SnapshotSection,
	domain::{
		McpCatalogView, McpNotificationsView, McpProbeOutcome, McpProbeView, McpPromptView,
		McpRegistryInputView, McpRegistryResultView, McpRegistryView, McpResourceView,
		McpServerCatalogView,
	},
};

/// One connected server offering one resource and one prompt, with its
/// subscriptions as `subscribed` states.
pub fn catalog(subscribed: &[&str]) -> SnapshotSection {
	SnapshotSection::McpCatalog(McpCatalogView {
		notifications: true,
		servers:       vec![McpServerCatalogView {
			server:        "docs".into(),
			resources:     vec![McpResourceView {
				uri:         "docs://readme".into(),
				name:        "readme".into(),
				description: None,
				mime_type:   Some("text/markdown".into()),
			}],
			templates:     Vec::new(),
			prompts:       vec![McpPromptView {
				name:        "summarize".into(),
				command:     "/docs:summarize".into(),
				description: None,
				arguments:   Vec::new(),
			}],
			notifies:      McpNotificationsView {
				tools_changed:     true,
				resources_changed: false,
				prompts_changed:   false,
				offers_resources:  true,
				subscribe:         true,
			},
			subscriptions: subscribed.iter().map(|uri| (*uri).to_owned()).collect(),
		}],
	})
}

/// A test of `docs` that connected and listed `tools`, or failed when `tools`
/// is `None`.
pub fn probe(tools: Option<&[&str]>) -> SnapshotSection {
	let outcome = match tools {
		Some(tools) => McpProbeOutcome::Connected {
			name:    "docs-server".into(),
			version: "1.0.0".into(),
			tools:   tools.iter().map(|tool| (*tool).to_owned()).collect(),
		},
		None => McpProbeOutcome::Failed { message: "connection refused".into() },
	};
	SnapshotSection::McpProbe(McpProbeView { server: "docs".into(), outcome })
}

/// The registry signed in, holding one result for `query`.
pub fn registry(query: &str) -> SnapshotSection {
	SnapshotSection::McpRegistry(McpRegistryView {
		signed_in: true,
		query:     Some(query.into()),
		results:   vec![McpRegistryResultView {
			id:          "acme/search".into(),
			name:        "Acme Search".into(),
			description: "Search the web".into(),
			transport:   "http".into(),
			use_count:   42,
			verified:    true,
			server:      "acme-search".into(),
			warnings:    Vec::new(),
			inputs:      vec![McpRegistryInputView {
				key:         "apiKey".into(),
				label:       "API key".into(),
				description: None,
				required:    true,
				default:     None,
				sensitive:   true,
				choices:     Vec::new(),
			}],
		}],
	})
}
