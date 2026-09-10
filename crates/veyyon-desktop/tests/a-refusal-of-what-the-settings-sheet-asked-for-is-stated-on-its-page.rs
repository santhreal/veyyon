//! WHY: every page of the settings sheet sends requests the host can refuse
//! -- a setting written, a setting reset, a binding rebound, a theme chosen,
//! a server enabled, a source re-run, a task spawned, an agent revived, a
//! provider signed into -- and the refusal belongs to the control that sent
//! it. Two defects, one class:
//!
//! 1. `surface_for_action` resolved none of them, so every request the sheet
//!    sent registered under `SurfaceId::GlobalTitlebarLine`. The hairlines
//!    General, MCP, Extensions, Diagnostics and Usage already drew read their
//!    own ids, so they could never carry a refusal, and the `Retry` that sends
//!    the refused request again was never offered.
//! 2. The auth actions that carry a provider resolved from the intent, which
//!    names none, so a cancel and a retry registered under
//!    `ProviderAuth*Button("")` -- an id no page draws.
//!
//! CLASS CLOSED: the sweep is over every sample intent's actions, filtered at
//! run time to the sheet's own capabilities, so an action added to any of
//! those families is covered by what it is. Each must land on a control
//! `SurfaceId::in_settings_sheet` accepts, must name what the action acts on,
//! and -- outside a pinned set of controls the auth flow draws from its own
//! state -- must be a control `gated_controls` also projects. The actions no
//! control of the sheet presses are pinned by exact equality. A failure on
//! any other gated control is required NOT to be stated on the sheet, and the
//! statement is resolved every projection, so a dismissal leaves it.
//!
//! NOT CAUGHT: where the row is drawn and what a press of its `Retry` sends,
//! which is `veyyon-desktop-surface`'s
//! `a-refusal-the-sheet-landed-is-drawn-on-its-page.rs`; that the auth page's
//! own controls read no availability, so they draw no pending mark; and
//! whether the host refuses these requests, which is the gui-host's suite.

mod support;

use std::collections::{BTreeSet, HashMap};

use support::settings_sheet::{seeded, sheet_control, sheet_requests, target_of_action, wire};
use veyyon_desktop::{land_failure, project, project::gated_controls, project_controls};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostActionKind, RequestId, RequestRegistry, SurfaceId,
};
use veyyon_desktop_surface::{Intent, SettingsPage, ShellState, navigation::SurfaceRoute};

const NOW_MS: u64 = 1_700_000_000_000;

/// The actions of the sheet's capabilities that no control of the sheet
/// presses: what the window reads when it opens a page, which is the window
/// navigating rather than the operator pressing anything. Every one of these
/// is also sent by a control -- a selector re-reading its catalogue, a
/// refresh button -- and the sweep sees both, so a kind here is a kind that
/// reached the titlebar under `Intent::Navigate` alone. Their failures are
/// the window's and land on its line.
const PINNED_NOT_A_PRESS: [HostActionKind; 8] = [
	HostActionKind::LoadSettings,
	HostActionKind::LoadThemes,
	HostActionKind::LoadKeybindings,
	HostActionKind::RefreshProviders,
	HostActionKind::RefreshMcp,
	HostActionKind::RefreshDiagnostics,
	HostActionKind::GetUsage,
	HostActionKind::GetContextBreakdown,
];

/// A refusal of `request`, in the host's own words.
fn refusal(request: RequestId, retryable: bool) -> BackendError {
	BackendError {
		scope: ErrorScope::Settings,
		code: Some("INVALID_VALUE".to_string()),
		message: "the host refused: expected a string".to_string(),
		retryable,
		request: Some(request),
		occurred_at_ms: NOW_MS,
	}
}

/// A shell with the sheet open on `page`, opened the way the window opens it.
fn opened_on(page: SettingsPage) -> ShellState {
	let mut state = ShellState { current_id: 1, ..ShellState::default() };
	Intent::Navigate(SurfaceRoute::Page(page)).apply(&mut state);
	state
}

/// Sends a request from `surface`, has the host refuse it, and projects: the
/// whole path from a registered request to what the sheet states, with
/// nothing written into `ShellState` by hand.
fn refused_on(kind: HostActionKind, surface: &SurfaceId, retryable: bool) -> ShellState {
	refused_on_page(kind, surface, retryable, SettingsPage::General)
}

/// The same, with the sheet open on a chosen page.
fn refused_on_page(
	kind: HostActionKind,
	surface: &SurfaceId,
	retryable: bool,
	page: SettingsPage,
) -> ShellState {
	let (store, mut index) = seeded();
	let mut registry = RequestRegistry::new();
	let request = RequestId(1);
	registry.register(request, kind, surface.clone(), NOW_MS, 30_000);

	let mut state = opened_on(page);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	land_failure(&refusal(request, retryable), &registry, Some(&wire()), &mut state);
	// The window completes the request the moment it lands the failure, so
	// the projection reads a control at rest with an error rather than one
	// still in flight.
	registry.complete(&request);
	project_controls(&store, &registry, &index, &mut state);
	state
}

/// What the sheet states, on a sheet that is open.
fn stated(state: &ShellState) -> Option<(SurfaceId, String, bool)> {
	state
		.overlay_settings()
		.expect("the sheet under test is open")
		.failure
		.as_ref()
		.map(|failure| {
			(failure.surface.clone(), failure.error.message.clone(), failure.error.retryable)
		})
}

#[test]
fn a_request_the_sheet_sends_lands_on_a_control_the_sheet_draws() {
	let mut not_a_press = BTreeSet::new();
	for (action, surface) in sheet_requests() {
		if surface.in_settings_sheet() {
			continue;
		}
		assert_eq!(
			surface,
			SurfaceId::GlobalTitlebarLine,
			"{:?} landed on {surface:?}, which is neither the sheet's nor the titlebar's",
			action.kind()
		);
		not_a_press.insert(action.kind());
	}
	assert_eq!(
		not_a_press,
		PINNED_NOT_A_PRESS.into_iter().collect::<BTreeSet<_>>(),
		"the actions of the sheet's capabilities that no control presses changed"
	);
}

#[test]
fn a_control_a_request_lands_on_names_what_the_action_acts_on() {
	for (action, surface) in sheet_requests() {
		if !surface.in_settings_sheet() {
			continue;
		}
		// A theme chosen writes the `theme` setting and re-reads the
		// catalogue, and both are the selector's own request: the press was
		// the selector rather than the field that setting is drawn as.
		if matches!(surface, SurfaceId::ThemeSelector) {
			assert!(
				matches!(target_of_action(&action), None | Some("theme")),
				"the theme selector sent {:?}, which acts on something else",
				action.kind()
			);
			continue;
		}
		let Some(target) = target_of_action(&action) else {
			assert_eq!(
				sheet_control(&surface).1,
				None,
				"{:?} names nothing and landed on a control keyed by something",
				action.kind()
			);
			continue;
		};
		assert_eq!(
			sheet_control(&surface).1,
			Some(target),
			"{:?} acts on {target} and landed on {surface:?}, which names something else",
			action.kind()
		);
	}
}

#[test]
fn every_sheet_action_registers_under_the_control_that_sends_it() {
	// Pinned by exact equality, so an action of any of these families added
	// to the window is red here until the control it belongs to is recorded,
	// and a send that registers under a neighbouring control -- the same
	// page, the wrong press -- is red rather than plausible.
	let table: BTreeSet<(String, &'static str)> = sheet_requests()
		.iter()
		.filter(|(_, surface)| surface.in_settings_sheet())
		.map(|(action, surface)| (format!("{:?}", action.kind()), sheet_control(surface).0))
		.collect();
	let pinned: BTreeSet<(String, &'static str)> = [
		("SetSetting", "SettingsField"),
		("SetSetting", "ThemeSelector"),
		("LoadThemes", "ThemeSelector"),
		("ResetSetting", "SettingsField"),
		("SetKeybinding", "KeybindingField"),
		("SetMcpEnabled", "McpEnableToggle"),
		("SpawnTask", "TaskSpawnButton"),
		("CancelTask", "TaskCancelButton"),
		("ReviveAgent", "AgentReviveButton"),
		("RefreshDiagnostics", "DiagnosticRefreshButton"),
		("RetryDiagnosticSource", "DiagnosticRetrySourceButton"),
		("GetUsage", "UsageRefreshButton"),
		("GetContextBreakdown", "ContextBreakdownRefreshButton"),
		("StartProviderAuth", "ProviderAuthStartButton"),
		("SubmitAuthSecret", "ProviderAuthSecretSubmit"),
		("OpenAuthUrl", "ProviderAuthUrlOpen"),
		("CancelAuthFlow", "ProviderAuthCancelButton"),
		("RetryAuthFlow", "ProviderAuthRetryButton"),
	]
	.map(|(kind, control)| (kind.to_owned(), control))
	.into();
	assert_eq!(table, pinned, "a settings action changed the control it registers under");
}

#[test]
fn a_control_a_request_lands_on_is_one_the_projection_gates() {
	let (store, index) = seeded();
	let gated: BTreeSet<SurfaceId> = gated_controls(&store, &index, Some(1))
		.into_iter()
		.map(|(surface, _)| surface)
		.collect();
	let ungated: BTreeSet<SurfaceId> = sheet_requests()
		.into_iter()
		.filter(|(_, surface)| surface.in_settings_sheet() && !gated.contains(surface))
		.map(|(_, surface)| surface)
		.collect();
	// The auth page draws its controls from the flow the host reports rather
	// than from `ControlStates`, so these four read no availability and no
	// gate projects them. They still carry a refusal, which is what this
	// suite is about; the pending mark they do not draw is stated in the
	// module comment and is not closed here.
	let pinned: BTreeSet<SurfaceId> = [
		SurfaceId::ProviderAuthSecretSubmit("anthropic".to_string()),
		SurfaceId::ProviderAuthUrlOpen("https://auth.example.com".to_string()),
		SurfaceId::ProviderAuthCancelButton("anthropic".to_string()),
		SurfaceId::ProviderAuthRetryButton("anthropic".to_string()),
	]
	.into();
	assert_eq!(ungated, pinned, "a control of the sheet reads an availability nothing projects");
}

#[test]
fn the_refusal_of_a_sheet_control_is_stated_on_its_page() {
	for (action, surface) in sheet_requests() {
		if !surface.in_settings_sheet() {
			continue;
		}
		let state = refused_on(action.kind(), &surface, true);
		let Some((stated_surface, message, retryable)) = stated(&state) else {
			panic!("{:?} refused on {surface:?} and the sheet states nothing", action.kind())
		};
		assert_eq!(stated_surface, surface, "the sheet states another control's refusal");
		assert_eq!(message, "the host refused: expected a string");
		assert!(retryable, "the host offered to be asked again");
	}
}

#[test]
fn a_refusal_is_stated_whichever_page_of_the_sheet_is_open() {
	// One sheet, one line: the operator is looking at the sheet they pressed
	// in, and a page that opened after the request was sent still states
	// what came back.
	let surface = SurfaceId::SettingsField("theme".to_string());
	for page in [SettingsPage::General, SettingsPage::Themes, SettingsPage::Diagnostics] {
		let state = refused_on_page(HostActionKind::SetSetting, &surface, true, page);
		assert_eq!(
			stated(&state).map(|(surface, ..)| surface),
			Some(surface.clone()),
			"the sheet open on {page:?} states nothing of what it asked for"
		);
	}
}

#[test]
fn a_refusal_the_host_calls_final_offers_no_second_send() {
	let surface = SurfaceId::SettingsField("theme".to_string());
	let state = refused_on(HostActionKind::SetSetting, &surface, false);
	let Some((_, _, retryable)) = stated(&state) else {
		panic!("the sheet states the refusal")
	};
	assert!(!retryable, "a refusal the host called final draws no Retry");
}

#[test]
fn a_refusal_of_another_surface_is_not_the_sheets() {
	let (store, index) = seeded();
	let elsewhere: Vec<SurfaceId> = gated_controls(&store, &index, Some(1))
		.into_iter()
		.map(|(surface, _)| surface)
		.filter(|surface| !surface.in_settings_sheet())
		.collect();
	assert!(elsewhere.len() > 10, "the store gates {} controls outside the sheet", elsewhere.len());
	for surface in elsewhere {
		let state = refused_on(HostActionKind::SubmitPrompt, &surface, true);
		assert_eq!(
			stated(&state),
			None,
			"a refusal on {surface:?} was stated on the sheet, which never sent it"
		);
	}
	let state = refused_on(HostActionKind::Attach, &SurfaceId::GlobalTitlebarLine, true);
	assert_eq!(stated(&state), None, "the titlebar's own line is not the sheet's");
}

#[test]
fn a_refusal_the_operator_dismissed_leaves_the_sheet() {
	let surface = SurfaceId::McpEnableToggle("mcp-server".to_string());
	let (store, index) = seeded();
	let mut state = refused_on(HostActionKind::SetMcpEnabled, &surface, true);
	assert!(stated(&state).is_some(), "the refusal is stated before it is dismissed");

	// The dismissal path the row's own control takes: the error leaves the
	// control, and the next projection restates what is left.
	state.controls.clear_error(&surface);
	project_controls(&store, &RequestRegistry::new(), &index, &mut state);
	assert_eq!(stated(&state), None, "the sheet held a failure the control no longer carries");
}

#[test]
fn the_sheet_states_nothing_while_nothing_is_refused() {
	let (store, mut index) = seeded();
	let mut state = opened_on(SettingsPage::General);
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &RequestRegistry::new(), &index, &mut state);
	assert_eq!(stated(&state), None, "a sheet nothing refused states nothing");
	assert!(
		!state
			.overlay_settings()
			.expect("the sheet under test is open")
			.settings
			.is_empty(),
		"the sheet under test has a setting to draw"
	);
}
