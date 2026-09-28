//! The sidebar selects, reveals and renames the session the host settled on.

use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::{OpenSelected, RenameSelected, SelectPrev},
	sidebar::Sidebar,
};
use veyyon_desktop_model::{HostAction, HostEvent, RequestId, SessionId, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme};

use super::{active, listing, refused, sid};

/// The sidebar over a window the host opened `a` in, listing alpha: b, a;
/// beta: c.
fn sidebar(app: &mut TestAppContext) -> (Entity<AppState>, &mut VisualTestContext) {
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		veyyon_desktop_app::keymap::install(cx).expect("the default keymap parses");
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(vec![listing(), active("a", "/w/alpha")], cx));
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| Sidebar::new(view_state, window, cx));
	cx.update(|window, cx| {
		let focus = view.focus_handle(cx);
		window.focus(&focus, cx);
	});
	cx.run_until_parked();
	state.update(cx, |state, _| state.drain_outbox());
	(state, cx)
}

fn apply(state: &Entity<AppState>, cx: &mut VisualTestContext, events: Vec<HostEvent>) {
	state.update(cx, |state, cx| state.apply(events, cx));
	cx.run_until_parked();
}

/// The `OpenSession` requests the window queued since the last call.
fn opens(state: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<(RequestId, SessionId)> {
	state.update(cx, |state, _| {
		state
			.drain_outbox()
			.into_iter()
			.filter_map(|request| match request.action {
				HostAction::OpenSession { session } => Some((request.id, session)),
				_ => None,
			})
			.collect()
	})
}

/// The session F2's rename field sends a new title for.
fn renamed(state: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<SessionId> {
	cx.dispatch_action(RenameSelected);
	cx.run_until_parked();
	cx.simulate_input(" renamed");
	cx.simulate_keystrokes("enter");
	cx.run_until_parked();
	state.update(cx, |state, _| {
		state
			.drain_outbox()
			.into_iter()
			.filter_map(|request| match request.action {
				HostAction::RenameSession { session, .. } => Some(session),
				_ => None,
			})
			.collect()
	})
}

fn shown(state: &Entity<AppState>, cx: &VisualTestContext) -> Option<SessionId> {
	state.read_with(cx, |state, _| state.active_session().cloned())
}

#[gpui::test]
fn the_session_the_host_acknowledges_is_selected_revealed_and_the_one_f2_renames(
	app: &mut TestAppContext,
) {
	let (state, cx) = sidebar(app);
	state.update(cx, |state, cx| state.toggle_project("/w/beta", cx));
	cx.run_until_parked();

	let request = state.update(cx, |state, cx| state.open_session(sid("c"), cx));
	apply(&state, cx, vec![active("c", "/w/beta"), HostEvent::RequestSucceeded { request }]);

	assert_eq!(shown(&state, cx), Some(sid("c")));
	assert!(
		!state.read_with(cx, |state, _| state.is_project_collapsed("/w/beta")),
		"the project the acknowledged session is listed in is expanded"
	);
	assert_eq!(renamed(&state, cx), vec![sid("c")]);
}

#[gpui::test]
fn a_refused_open_hands_the_selection_and_the_rename_field_back_to_the_hosts_session(
	app: &mut TestAppContext,
) {
	let (state, cx) = sidebar(app);
	// `a` is open and selected; `b` is the line above it.
	cx.dispatch_action(SelectPrev);
	cx.dispatch_action(OpenSelected);
	cx.run_until_parked();
	let [(request, opened)] = opens(&state, cx).try_into().unwrap();
	assert_eq!((opened, shown(&state, cx)), (sid("b"), Some(sid("b"))));

	apply(&state, cx, vec![refused(request)]);
	assert_eq!(shown(&state, cx), Some(sid("a")), "the refusal returns to the host's session");
	assert_eq!(renamed(&state, cx), vec![sid("a")]);
}

#[gpui::test]
fn once_an_open_is_refused_the_window_follows_the_session_the_host_makes_active(
	app: &mut TestAppContext,
) {
	let (state, cx) = sidebar(app);
	let request = state.update(cx, |state, cx| state.open_session(sid("b"), cx));
	apply(&state, cx, vec![refused(request)]);
	assert_eq!(shown(&state, cx), Some(sid("a")));

	// The host makes `c` active, as it does for a session it created.
	apply(&state, cx, vec![active("c", "/w/beta")]);
	assert_eq!(shown(&state, cx), Some(sid("c")), "no open is in flight once it was refused");
	assert_eq!(renamed(&state, cx), vec![sid("c")]);
}

#[gpui::test]
fn while_an_open_is_in_flight_another_session_the_host_reports_does_not_displace_it(
	app: &mut TestAppContext,
) {
	let (state, cx) = sidebar(app);
	let request = state.update(cx, |state, cx| state.open_session(sid("b"), cx));
	apply(&state, cx, vec![active("c", "/w/beta")]);
	assert_eq!(shown(&state, cx), Some(sid("b")), "the header predates the open");

	apply(&state, cx, vec![active("b", "/w/alpha"), HostEvent::RequestSucceeded { request }]);
	assert_eq!(shown(&state, cx), Some(sid("b")));
	assert_eq!(renamed(&state, cx), vec![sid("b")]);
}
