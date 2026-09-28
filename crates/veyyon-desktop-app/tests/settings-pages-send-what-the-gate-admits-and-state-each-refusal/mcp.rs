//! The MCP page states what a test of a server found beside that server's
//! row, and under the servers what each connected one offers besides tools:
//! its prompts with their arguments, its resources with their MIME type and
//! subscription, its resource templates, and the changes it announces.

use gpui::TestAppContext;
use serde_json::json;
use veyyon_desktop_model::{
	HostEvent, SnapshotSection,
	domain::{McpCatalogView, McpProbeView},
};

use super::harness::{accounts_and_servers, window};

#[gpui::test]
fn a_test_is_stated_under_its_server_and_the_catalog_under_the_servers(app: &mut TestAppContext) {
	let probe: McpProbeView = serde_json::from_value(json!({
		"server": "files",
		"outcome": { "Connected": { "name": "files-server", "version": "1.2.0", "tools": ["read", "write"] } },
	}))
	.expect("the probe fixture decodes");
	let catalog: McpCatalogView = serde_json::from_value(json!({
		"notifications": true,
		"servers": [{
			"server": "files",
			"resources": [{
				"uri": "file:///README.md", "name": "readme",
				"description": "The readme", "mime_type": "text/markdown",
			}],
			"templates": [{ "uri_template": "file:///logs/{day}", "name": "log", "description": null }],
			"prompts": [{
				"name": "summarize", "command": "/files:summarize", "description": "Summarize a tree",
				"arguments": [
					{ "name": "path", "description": null, "required": true },
					{ "name": "depth", "description": null, "required": false },
				],
			}],
			"notifies": {
				"tools_changed": true, "resources_changed": false, "prompts_changed": false,
				"offers_resources": true, "subscribe": true,
			},
			"subscriptions": ["file:///README.md"],
		}],
	}))
	.expect("the catalog fixture decodes");
	let mut events = accounts_and_servers();
	events.push(HostEvent::Snapshot(SnapshotSection::McpProbe(probe)));
	events.push(HostEvent::Snapshot(SnapshotSection::McpCatalog(catalog)));
	let mut w = window(app, events);
	w.open("mcp");
	for line in [
		"Test: connected to files-server 1.2.0, 2 tools: read, write",
		"Server notifications are on (mcp.notifications)",
		"1 prompt · 1 resource · 1 template",
		"announces changed tools · accepts subscriptions",
		"/files:summarize <path> [depth] · Summarize a tree",
		"readme file:///README.md (text/markdown) (subscribed) · The readme",
		"log file:///logs/{day}",
	] {
		assert!(w.draws(line), "the page draws {line:?}");
	}
}
