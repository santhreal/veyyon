//! WHY: when a window held no session, the desktop client previously drew an
//! input opening line and composer in the session column as if an empty prompt
//! were in hand, without explaining that no session exists or providing
//! controls to start, resume, or configure models. When no provider was
//! configured, the user was left in the dark without navigation to account
//! setup.
//!
//! CLASS CLOSED: a window holding no session draws a welcome surface in the
//! session column. Driven through the real store and projection:
//! 1. A store with zero sessions routes to the welcome surface and offers three
//!    controls that dispatch the intents they claim: `NewSession`,
//!    `FindSessions("")`, and `OpenOverlay` for the model picker.
//! 2. Closing the last session through the real index reduction drops the
//!    active pointer and reprojects to the same welcome surface.
//! 3. When no provider is configured, the surface states that condition first
//!    and provides a control to open the account surface
//!    (`Navigate(SurfaceRoute::Account)`). Sweeps both provider states.
//! 4. Empty prose constraints are validated against the welcome surface copy.
//!
//! NOT CAUGHT: network transport errors during session creation or remote host
//! execution of the dispatched intents.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, fields::driven};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	ConnectionState, HostEvent, PROTOCOL_VERSION, ProviderView, QueuePartition, SessionId,
	SnapshotSection, Store, Versioned, reduce,
};
use veyyon_desktop_scene::headless::Captured;
use veyyon_desktop_surface::{
	Intent, PaletteMode, ShellState, empty::EmptySurface, navigation::SurfaceRoute,
};
use veyyon_gpui::{Bounds, Pixels, Point, TextRunLayout};

fn squeezed(s: &str) -> String {
	s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn drawn_text(captured: &Captured) -> String {
	captured
		.text_runs
		.iter()
		.flat_map(|run| run.text.as_ref().chars())
		.filter(|character| !character.is_whitespace())
		.collect()
}

fn centre_of_run(runs: &[TextRunLayout], label: &str) -> Point<Pixels> {
	let matched: Vec<&TextRunLayout> = runs
		.iter()
		.filter(|run| run.text.as_ref() == label)
		.collect();
	assert_eq!(
		matched.len(),
		1,
		"the frame draws exactly one run reading {label:?}; it drew {:?}",
		runs.iter().map(|r| r.text.as_ref()).collect::<Vec<_>>()
	);
	let bounds: Bounds<Pixels> = matched[0].bounds;
	Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

fn project_store(store: &Store) -> ShellState {
	let mut state = ShellState::default();
	let emulators = HashMap::new();
	let mut index = SessionIndex::default();
	project(store, &mut index, &emulators, NOW_MS, &mut state);
	state
}

fn connected_store() -> Store {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "unix:/run/veyyon.sock".to_owned(),
		protocol: PROTOCOL_VERSION,
	};
	store
}

fn authed_provider() -> ProviderView {
	ProviderView {
		id:            "anthropic".to_owned(),
		name:          "Anthropic".to_owned(),
		authenticated: true,
		oauth:         false,
		api_key:       true,
	}
}

#[test]
fn a_store_with_zero_sessions_routes_to_welcome_and_controls_dispatch_intents() {
	let mut store = connected_store();
	store.domains.providers = vec![authed_provider()];
	let state = project_store(&store);
	assert!(!state.has_sessions(), "store has zero sessions");
	assert!(state.providers_configured(), "providers are configured");

	let welcome_copy = EmptySurface::Welcome.copy();

	driven(state, |session| {
		let captured = session.frame().expect("a frame renders");
		let text = drawn_text(&captured);
		assert!(
			text.contains(&squeezed(welcome_copy.condition)),
			"frame draws welcome condition {:?}, got {text}",
			welcome_copy.condition
		);
		assert!(
			text.contains(&squeezed(welcome_copy.action)),
			"frame draws welcome action {:?}, got {text}",
			welcome_copy.action
		);

		// 1. "Open session" control dispatches Intent::NewSession
		let pt = centre_of_run(&captured.text_runs, "Open session");
		session.click(pt).expect("click Open session");
		let intents = session
			.update(|view, _, _| view.drain_intents())
			.expect("drains intents");
		assert_eq!(intents, vec![Intent::NewSession]);

		// 2. "Resume session" control dispatches Intent::FindSessions("")
		let pt = centre_of_run(&captured.text_runs, "Resume session");
		session.click(pt).expect("click Resume session");
		let intents = session
			.update(|view, _, _| view.drain_intents())
			.expect("drains intents");
		assert_eq!(intents, vec![Intent::FindSessions(String::new())]);

		// Dismiss overlay opened by FindSessions so underlying buttons are reachable
		// again
		session
			.update(|view, _, cx| view.dispatch(Intent::CloseOverlay, cx))
			.expect("close overlay");
		let captured = session.frame().expect("re-render without overlay");

		// 3. "Set model" control opens the model picker palette overlay
		let pt = centre_of_run(&captured.text_runs, "Set model");
		session.click(pt).expect("click Set model");
		let mode = session
			.update(|view, _, _| view.state().overlay_palette().map(|palette| palette.mode))
			.expect("read overlay");
		assert_eq!(mode, Some(PaletteMode::Models));
	});
}

#[test]
fn closing_the_last_session_lands_on_the_welcome_surface() {
	let mut store = connected_store();
	store.domains.providers = vec![authed_provider()];
	let id = SessionId::from("s1");
	store
		.sessions
		.insert(support::session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id);

	let state_with_session = project_store(&store);
	assert!(state_with_session.has_sessions(), "initial store has session");

	// Close the last session through the real index reduction
	let empty_index = HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 2, value: Vec::new() },
		Vec::new(),
	));
	reduce(&mut store, empty_index);
	assert!(store.sessions.items.is_empty(), "sessions emptied");
	assert_eq!(store.persisted.shell.active_session, None, "active session cleared");

	let state_after_close = project_store(&store);
	assert!(!state_after_close.has_sessions(), "state has no sessions after close");

	let welcome_copy = EmptySurface::Welcome.copy();
	driven(state_after_close, |session| {
		let captured = session.frame().expect("a frame renders");
		let text = drawn_text(&captured);
		assert!(
			text.contains(&squeezed(welcome_copy.condition)),
			"closing last session renders welcome condition"
		);
		assert!(
			text.contains(&squeezed(welcome_copy.action)),
			"closing last session renders welcome action"
		);
	});
}

#[test]
fn no_provider_condition_sweeps_both_states() {
	// State 1: No provider configured
	let store_no_provider = connected_store();
	assert!(store_no_provider.domains.providers.is_empty());
	let state_no_provider = project_store(&store_no_provider);
	assert!(!state_no_provider.has_sessions());
	assert!(!state_no_provider.providers_configured());

	let no_provider_copy = EmptySurface::WelcomeNoProvider.copy();
	driven(state_no_provider, |session| {
		let captured = session.frame().expect("a frame renders");
		let text = drawn_text(&captured);
		assert!(text.contains(&squeezed(no_provider_copy.condition)), "draws no-provider condition");
		assert!(text.contains(&squeezed(no_provider_copy.action)), "draws no-provider action");

		// Account button is present and dispatches SurfaceRoute::Account
		let pt = centre_of_run(&captured.text_runs, "Account");
		session.click(pt).expect("click Account");
		let intents = session
			.update(|view, _, _| view.drain_intents())
			.expect("drains intents");
		assert_eq!(intents, vec![Intent::Navigate(SurfaceRoute::Account)]);
	});

	// State 2: Provider configured -> changes sentences and controls
	let mut store_with_provider = connected_store();
	store_with_provider.domains.providers = vec![authed_provider()];
	let state_with_provider = project_store(&store_with_provider);
	assert!(state_with_provider.providers_configured());

	let welcome_copy = EmptySurface::Welcome.copy();
	driven(state_with_provider, |session| {
		let captured = session.frame().expect("a frame renders");
		let text = drawn_text(&captured);
		assert!(text.contains(&squeezed(welcome_copy.condition)), "draws welcome condition");
		assert!(text.contains(&squeezed(welcome_copy.action)), "draws welcome action");
		assert!(
			!text.contains(&squeezed(no_provider_copy.condition)),
			"does not draw no-provider condition"
		);
	});
}
