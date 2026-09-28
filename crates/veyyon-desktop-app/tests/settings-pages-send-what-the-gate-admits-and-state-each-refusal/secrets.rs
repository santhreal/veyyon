//! A masked input of the MCP registry's add form sends what was typed into
//! it, from the button and from Enter alike, and never draws it.
//!
//! WHY: a masked input draws glyphs rather than its text, so a form that read
//! the wrong input, a stale value or its default sends a key that is not the
//! one typed and nothing on screen shows the difference. The provider's
//! pasted code is the other masked input and is
//! `a_pasted_code_is_drawn_masked_and_sent_once`.
//!
//! Gap: one result with one masked and one choice input; whether the host
//! stores the key it is sent is the host's.

use gpui::{TestAppContext, px, size};
use veyyon_desktop_model::{
	HostAction, HostEvent, SnapshotSection,
	action::{McpRegistryInputValue, McpRequest},
	domain::{McpRegistryInputView, McpRegistryResultView, McpRegistryView},
};

use super::harness::{accounts_and_servers, window};

const RESULT: &str = "acme-search";

/// A registry search that found one server asking for a secret key and a
/// region with a default.
fn found() -> HostEvent {
	let input = |key: &str, label: &str| McpRegistryInputView {
		key:         key.to_owned(),
		label:       label.to_owned(),
		description: None,
		required:    true,
		default:     None,
		sensitive:   false,
		choices:     Vec::new(),
	};
	let key = McpRegistryInputView { sensitive: true, ..input("apiKey", "API key") };
	let region = McpRegistryInputView {
		required: false,
		default: Some("us".to_owned()),
		choices: vec!["us".to_owned(), "eu".to_owned()],
		..input("region", "Region")
	};
	HostEvent::Snapshot(SnapshotSection::McpRegistry(McpRegistryView {
		signed_in: true,
		query:     Some("search".to_owned()),
		results:   vec![McpRegistryResultView {
			id:          RESULT.to_owned(),
			name:        "Acme Search".to_owned(),
			description: "Searches the web".to_owned(),
			transport:   "http".to_owned(),
			use_count:   3,
			verified:    false,
			server:      "acme".to_owned(),
			warnings:    Vec::new(),
			inputs:      vec![key, region],
		}],
	}))
}

fn deploy(secret: &str) -> HostAction {
	HostAction::McpManage(McpRequest::DeployMcpRegistryServer {
		result: RESULT.to_owned(),
		server: "acme".to_owned(),
		inputs: vec![McpRegistryInputValue { key: "apiKey".to_owned(), value: secret.to_owned() }],
	})
}

#[gpui::test]
fn a_secret_typed_into_the_add_form_is_sent_as_typed_by_the_button_and_by_enter(
	app: &mut TestAppContext,
) {
	let mut events = accounts_and_servers();
	events.push(found());
	let mut w = window(app, events);
	// Tall enough that the unfolded form under the registry heading fits.
	w.cx.simulate_resize(size(px(1200.0), px(1600.0)));
	w.open("mcp#registry");
	w.sent();
	let unfold = format!("settings.control:mcp-result-{RESULT}");
	let secret = format!("mcp-deploy:{RESULT}:input:apiKey");

	w.click(&unfold);
	w.click(&format!("settings.control:mcp-deploy-{RESULT}"));
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a required secret left empty is not sent");
	assert!(w.draws("API key is required"));

	w.type_into(&secret, "sk-typed-1234");
	assert!(!w.draws("sk-typed-1234"), "the secret is never drawn");
	w.click(&format!("settings.control:mcp-deploy-{RESULT}"));
	assert_eq!(w.sent(), vec![deploy("sk-typed-1234")], "the button sends what was typed");

	w.click(&unfold);
	w.type_into(&secret, "sk-other-5678");
	w.keys("enter");
	assert_eq!(w.sent(), vec![deploy("sk-other-5678")], "Enter sends what was typed");
}
