//! The settings view draws each page from what the host reports, sends what
//! a control changes, asks before a control that deletes, and states on the
//! page why the host refused, or would refuse, what the page sent.
//!
//! WHY: settings are where a value typed wrong, a credential deleted by a
//! stray click or a refusal nobody sees does lasting damage. Every request a
//! page sends passes through one place, which holds back what the gate
//! rejects; a control that bypassed it (an input's Enter, a dialog's confirm,
//! a button drawn without a gate check) sends a request the host refuses
//! with no word on the page. The suite drives the real `SettingsView` inside
//! the real `Workspace` over an `AppState` fed host events, clicks the driver
//! targets the pages register and reads the drawn text and the requests
//! queued.
//!
//! Gap: the scroll to an anchored section is not measured, only the tab the
//! anchor picks; the Extensions page, the host's theme rows and an MCP
//! server's switch are reached but not driven here.

mod appearance;
mod focus;
mod harness;
mod mcp;

use gpui::{TestAppContext, point, px};
use serde_json::json;
use veyyon_desktop_app::settings::Page;
use veyyon_desktop_model::{
	AuthFlowState, AuthFlowView, Capability, CapabilityStatus, HostAction, HostEvent,
	KeybindingView, RequestId, SnapshotSection,
	action::{AccountsRequest, McpRequest},
};
use veyyon_desktop_ui::{editor::MASK_GLYPH, theme::size as measure};

use self::harness::{accounts_and_servers, refused, settings, window};

#[gpui::test]
fn each_page_opens_from_its_nav_entry_and_asks_the_host_for_what_it_draws(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![settings()]);
	w.open("general");
	assert_eq!(w.sent(), vec![HostAction::LoadSettings]);
	let entry = w
		.bounds("settings.page:general")
		.expect("the nav entry is laid out");
	let chip = w
		.bounds("settings.control:settings-tab-appearance")
		.expect("the tab strip is laid out");
	assert!(entry.size.width < measure::SETTINGS_NAV, "the entry sits inside the nav column");
	assert!(entry.right() < chip.left(), "the page is drawn right of the nav");

	for page in Page::ALL {
		w.click(&format!("settings.page:{}", page.name()));
		assert_eq!(w.page(), page);
		assert_eq!(w.layout().settings_page.as_deref(), Some(page.name()), "settings reopen on it");
		assert_eq!(w.sent(), page.loads(), "{page:?} asks for what it draws, once");
		assert!(w.draws(page.description()), "{page:?} states what it holds");
	}
	assert_eq!(
		w.bounds("settings.control:settings-tab-appearance"),
		None,
		"a control of a page no longer shown is forgotten"
	);
	w.cx
		.dispatch_action(veyyon_desktop_app::actions::workspace::CloseSettings);
	w.cx.run_until_parked();
	assert_eq!(w.bounds("settings.page:general"), None, "closed settings leave no target");
}

#[gpui::test]
fn an_anchor_picks_the_tab_it_names_and_a_tab_chip_picks_another(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context/Retry");
	assert!(w.draws("Retry failed requests") && w.draws("Compaction threshold"));
	assert!(!w.draws("Status line preset"), "another tab's settings are not drawn");
	w.click("settings.control:settings-tab-appearance");
	assert!(w.draws("Status line preset") && w.draws("Transitions"));
	assert!(!w.draws("Retry failed requests"));
	w.open("general#context");
	assert!(w.draws("Compaction threshold"), "an anchor naming a tab alone picks it");
}

#[gpui::test]
fn a_query_lists_what_it_matches_on_every_tab_and_fold_and_never_a_hidden_setting(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![settings()]);
	w.open("general");
	assert!(w.draws("Transitions") && !w.draws("Retry failed requests"), "one tab at a time");
	// Each query is held by one field of one setting: its label (typed in
	// another case), its key, its description, its group.
	let cases = [
		("FAILED", "Retry failed requests", "Context · Retry"),
		("maxdelay", "Longest retry delay", "Context · Retry"),
		("milliseconds", "Longest retry delay", "Context · Retry"),
		("motion", "Transitions", "Appearance · Motion"),
	];
	let labels = [
		"Transitions",
		"Status line preset",
		"Compaction threshold",
		"Retry failed requests",
		"Longest retry delay",
	];
	for (query, listed, heading) in cases {
		w.type_into("settings-query", query);
		assert!(w.draws(heading), "{query:?} files its match under {heading:?}");
		for label in labels {
			assert_eq!(w.draws(label), label == listed, "{query:?} lists {label:?}");
		}
		assert_eq!(w.bounds("settings.control:settings-tab-appearance"), None, "no tab strip");
		assert!(!w.draws("Show advanced settings"), "a search reaches into the fold");
	}
	w.type_into("settings-query", "argot");
	assert!(w.draws("No setting matches “argot”"), "a hidden setting is never listed");
	assert!(!w.draws("Argot models"));
	w.type_into("settings-query", "");
	assert!(
		w.draws("Transitions")
			&& w
				.bounds("settings.control:settings-tab-appearance")
				.is_some()
	);

	w.type_into("settings-query", "failed");
	w.open("general#context/Retry");
	assert!(w.draws("Compaction threshold"), "naming a section clears the search");
}

#[gpui::test]
fn enter_sends_the_typed_value_as_its_type_and_states_why_other_text_is_not_one(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	w.submit("compaction.threshold", "lots");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert!(w.draws("lots is not a number"));
	w.submit("compaction.threshold", "150");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert!(w.draws("The highest value is 100"));
	w.submit("compaction.threshold", "42");
	let key = "compaction.threshold".to_owned();
	assert_eq!(w.sent(), vec![HostAction::SetSetting { key, value: json!(42) }]);
	assert!(!w.draws("The highest value is 100"), "a value sent clears the statement");
}

#[gpui::test]
fn a_choice_of_an_array_setting_adds_or_drops_itself(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general#appearance/Status Line");
	w.sent();
	let key = "statusLine.segments".to_owned();
	let set = |items: &[&str]| HostAction::SetSetting { key: key.clone(), value: json!(items) };
	w.click("settings.control:choice-statusLine.segments-cost");
	assert_eq!(w.sent(), vec![set(&["model", "cost"])], "a chip not held adds itself");
	w.click("settings.control:choice-statusLine.segments-model");
	assert_eq!(w.sent(), vec![set(&["cost"])], "a chip held drops itself");
}

#[gpui::test]
fn a_switch_sends_the_position_it_is_flipped_to_and_reset_sends_the_default(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	let key = "retry.enabled".to_owned();
	let set = |on: bool| HostAction::SetSetting { key: key.clone(), value: json!(on) };
	w.click("settings.control:toggle-retry.enabled");
	assert_eq!(w.sent(), vec![set(true)]);
	w.click("settings.control:toggle-retry.enabled");
	assert_eq!(w.sent(), vec![set(false)], "a second flip starts from the position the first drew");
	w.click("settings.control:reset-retry.enabled");
	assert_eq!(w.sent(), vec![HostAction::ResetSetting { key }]);
	assert_eq!(
		w.bounds("settings.control:reset-compaction.threshold"),
		None,
		"a setting at its default offers no reset"
	);
}

#[gpui::test]
fn a_change_is_drawn_from_the_click_and_a_refused_one_draws_the_host_value_again(
	app: &mut TestAppContext,
) {
	let binding = KeybindingView {
		action: "app.palette".to_owned(),
		keys:   vec!["ctrl+k".to_owned()],
		source: "default".to_owned(),
	};
	let bindings = HostEvent::Snapshot(SnapshotSection::Keybindings(vec![binding]));
	let mut w = window(app, vec![settings(), bindings]);
	w.open("general#context");
	w.sent();
	let reset = "settings.control:reset-retry.enabled";
	w.click("settings.control:toggle-retry.enabled");
	let flip = w.one();
	assert_eq!(w.bounds(reset), None, "the switch is drawn at the default before the host answers");
	w.apply(vec![refused(flip.id, "SETTING_LOCKED", "retry.enabled is locked", 1)]);
	assert!(w.bounds(reset).is_some(), "a refused flip draws the host's position again");

	w.click("settings.control:toggle-retry.enabled");
	let flip = w.one();
	let HostEvent::Snapshot(SnapshotSection::Settings(mut written)) = settings() else {
		unreachable!("the fixture is the settings section");
	};
	if let Some(entry) = written.get_mut("retry.enabled") {
		entry.value = json!(true);
	}
	let answer = HostEvent::RequestSucceeded { request: flip.id };
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Settings(written)), answer]);
	assert_eq!(w.bounds(reset), None, "the host's answer draws what it wrote");

	w.open("keybindings");
	w.sent();
	let source = |w: &mut harness::Win<'_>, text: &str| w.texts().iter().any(|t| t == text);
	w.click("settings.control:edit-binding-app.palette");
	w.submit("keybinding", "ctrl+p");
	let rebind = w.one();
	assert!(source(&mut w, "user"), "the binding typed is drawn as the user's before the answer");
	w.apply(vec![refused(rebind.id, "KEY_TAKEN", "ctrl+p is taken", 2)]);
	assert!(source(&mut w, "default") && !source(&mut w, "user"), "a refusal draws the host's");
}

#[gpui::test]
fn a_refusal_is_stated_on_the_page_until_the_next_request_is_taken(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	w.click("settings.control:toggle-retry.enabled");
	let flip = w.one();
	w.apply(vec![refused(RequestId(900), "OTHER", "Another control was refused", 1)]);
	assert_eq!(w.bounds("settings.error"), None, "a refusal of another control's request");
	let locked = "retry.enabled is locked by the project";
	w.apply(vec![refused(flip.id, "SETTING_LOCKED", locked, 2)]);
	assert!(w.bounds("settings.error").is_some() && w.draws(locked));

	w.click("settings.control:reset-retry.enabled");
	let reset = w.one();
	assert!(w.draws(locked), "the statement stays while the next request is in flight");
	w.apply(vec![HostEvent::RequestSucceeded { request: reset.id }]);
	assert_eq!(w.bounds("settings.error"), None);
	assert!(!w.draws(locked), "a request taken clears it");
}

#[gpui::test]
fn a_request_the_gate_rejects_is_sent_by_no_control_and_its_reason_is_stated(
	app: &mut TestAppContext,
) {
	let reason = "Settings are read-only on this host";
	let closed = CapabilityStatus::Unavailable { reason: reason.to_owned() };
	let events = vec![
		settings(),
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(Capability::Settings, closed)])),
	];
	let mut w = window(app, events);
	w.open("general#context");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "the page asks for nothing the gate rejects");
	assert!(w.bounds("settings.error").is_some() && w.draws(reason));
	w.click("settings.control:toggle-retry.enabled");
	w.click("settings.control:reset-retry.enabled");
	w.submit("compaction.threshold", "42");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a switch, a button and an input alike");
}

#[gpui::test]
fn a_control_that_deletes_asks_first_and_only_the_confirmation_sends(app: &mut TestAppContext) {
	let mut w = window(app, accounts_and_servers());
	let sign_out =
		AccountsRequest::SignOutAccount { provider: "anthropic".to_owned(), credential_id: 7 };
	let mcp = HostAction::McpManage;
	let server = || "files".to_owned();
	let cases = [
		(
			"providers",
			"sign-out-anthropic-7",
			"Sign out of work@example.com?",
			HostAction::Accounts(sign_out),
		),
		(
			"mcp",
			"mcp-clear-auth-files",
			"Sign out of files?",
			mcp(McpRequest::ClearMcpServerAuth { server: server() }),
		),
		(
			"mcp",
			"mcp-remove-files",
			"Remove files?",
			mcp(McpRequest::RemoveMcpServer { server: server() }),
		),
		("mcp", "mcp-registry-logout", "Sign out of Smithery?", mcp(McpRequest::LogoutMcpRegistry)),
	];
	for (at, (page, control, question, action)) in (10..).zip(cases) {
		w.open(page);
		w.sent();
		// An action sent once the last question closed reaches the
		// workspace, so the page asked for opens.
		assert_eq!(w.page().name(), page, "{page} opens");
		let control = format!("settings.control:{control}");

		w.click(&control);
		assert!(w.bounds("dialog").is_some() && w.draws(question), "{control} asks {question:?}");
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "{control} sends nothing while asking");
		w.keys("escape");
		assert_eq!(w.bounds("dialog"), None, "Escape closes the question");
		assert!(w.layout().settings_open, "and not settings behind it");
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "Escape sends nothing");

		w.click(&control);
		let card = w.bounds("dialog").expect("the question is asked again");
		w.click_at(point(card.center().x, card.bottom() + px(24.0)));
		assert_eq!(w.bounds("dialog"), None, "a click on the dimmed page closes it");
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "and sends nothing");

		w.click(&control);
		w.keys("enter");
		assert_eq!(w.bounds("dialog"), None, "Enter closes the question");
		let confirmed = w.one();
		assert_eq!(confirmed.action, action, "Enter sends what {control} asked about");
		let why = format!("{question} was refused");
		w.apply(vec![refused(confirmed.id, "REFUSED", &why, at)]);
		assert!(w.draws(&why), "the refusal of a confirmed request is the page's");
	}
}

#[gpui::test]
fn the_providers_page_draws_each_account_under_its_provider(app: &mut TestAppContext) {
	let mut w = window(app, accounts_and_servers());
	w.open("providers#accounts");
	assert_eq!(w.sent(), vec![HostAction::RefreshProviders]);
	for drawn in
		["Anthropic", "Signed in · sign-in or API key", "work@example.com", "OAuth · in use"]
	{
		assert!(w.draws(drawn), "{drawn:?} is drawn");
	}
	assert!(w.bounds("settings.control:sign-out-anthropic-7").is_some());

	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Accounts(Vec::new()))]);
	assert!(w.draws("No stored accounts"));
	assert!(w.draws("Signed in from environment"), "a login read from the environment");
	assert_eq!(
		w.bounds("settings.control:sign-out-anthropic-7"),
		None,
		"the row of a signed-out account is forgotten"
	);
}

#[gpui::test]
fn a_pasted_code_is_drawn_masked_and_sent_once(app: &mut TestAppContext) {
	let url = "https://auth.example/authorize";
	let mut events = accounts_and_servers();
	events.push(HostEvent::Snapshot(SnapshotSection::AuthFlow(AuthFlowView {
		provider: "anthropic".to_owned(),
		state:    AuthFlowState::AwaitingSecret,
		url:      Some(url.to_owned()),
		prompt:   Some("Paste the authorization code".to_owned()),
		message:  None,
	})));
	let mut w = window(app, events);
	w.open("providers");
	w.sent();
	assert!(w.draws(url) && w.draws("Paste the authorization code"));
	w.click("settings.control:auth-open-url");
	assert_eq!(w.sent(), vec![HostAction::OpenAuthUrl { url: url.to_owned() }]);

	w.click("settings.field:auth-secret");
	w.cx.simulate_input("code-1234");
	w.cx.run_until_parked();
	let texts = w.texts();
	let mask: String = std::iter::repeat_n(MASK_GLYPH, "code-1234".len()).collect();
	assert!(texts.contains(&mask), "one mask glyph per character is drawn: {texts:?}");
	assert!(!texts.iter().any(|text| text.contains("code-1234")), "the code is never drawn");
	w.keys("enter");
	let submitted = HostAction::SubmitAuthSecret {
		provider: "anthropic".to_owned(),
		secret:   "code-1234".to_owned(),
	};
	assert_eq!(w.sent(), vec![submitted]);
	assert!(!w.draws(&mask), "the input is emptied once the code is sent");
	w.keys("enter");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "an empty input sends nothing");
}
