//! WHY: §8.10 remembers a window's geometry and its active session, and both
//! come back from a machine that has since changed. A rect left on a monitor
//! that is now unplugged reopens the window where no pointer reaches it, and a
//! session the host has since deleted leaves the window pointed at nothing
//! while its own store still names it.
//!
//! The class this closes is a remembered value applied without asking whether
//! it still exists: a display, a size below what the shell can draw, and a
//! session id. Each case is driven through the function the binary calls, so a
//! window that cannot be reached fails here rather than on the operator's
//! desk.
//!
//! What it does not catch: whether the platform honours the bounds it is
//! given, which is the window manager's, and whether the host answers
//! `OpenSession`, which the host suite covers.

mod support;

use veyyon_desktop::state::{Keeper, StateDir, placement};
use veyyon_desktop_model::{PersistedState, QueuePartition, SessionId, Store};
use veyyon_gpui::{Bounds, Pixels, Point, Size, px};

/// The floor the shell draws at, which is what a remembered size is raised to.
const MIN_WIDTH: f32 = 800.0;
const MIN_HEIGHT: f32 = 600.0;

/// One display, at the origin, 1920 by 1080.
const fn primary() -> Bounds<Pixels> {
	Bounds {
		origin: Point { x: px(0.0), y: px(0.0) },
		size:   Size { width: px(1920.0), height: px(1080.0) },
	}
}

/// A state remembering a window at `x`, `y` of `width` by `height`.
fn remembered(x: i32, y: i32, width: u32, height: u32) -> PersistedState {
	let mut state = PersistedState::new();
	state.window.x = x;
	state.window.y = y;
	state.window.width = width;
	state.window.height = height;
	state
}

#[test]
fn a_window_on_a_display_this_machine_still_has_opens_where_it_was() {
	let state = remembered(220, 140, 1480, 920);
	let (bounds, maximized) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(!maximized);
	assert_eq!(f32::from(bounds.origin.x), 220.0);
	assert_eq!(f32::from(bounds.origin.y), 140.0);
	assert_eq!(f32::from(bounds.size.width), 1480.0);
	assert_eq!(f32::from(bounds.size.height), 920.0);
}

#[test]
fn a_window_off_every_display_comes_back_centred_on_one_that_exists() {
	// The rect a second monitor to the right left behind, after it was
	// unplugged.
	let state = remembered(3200, 400, 1480, 920);
	let (bounds, _) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(
		primary().contains(&bounds.center()),
		"the window opens on a display that exists: {bounds:?}"
	);
	assert_eq!(
		f32::from(bounds.size.width),
		1480.0,
		"the remembered size is kept; only the place it was is gone"
	);
	assert_eq!(f32::from(bounds.size.height), 920.0);
}

#[test]
fn a_window_the_platform_reports_no_display_for_still_opens() {
	let state = remembered(3200, 400, 1480, 920);
	let (bounds, _) = placement(&state, &[], MIN_WIDTH, MIN_HEIGHT);
	assert_eq!(f32::from(bounds.origin.x), 0.0);
	assert_eq!(f32::from(bounds.origin.y), 0.0);
	assert_eq!(f32::from(bounds.size.width), 1480.0);
}

#[test]
fn a_remembered_size_under_the_floor_opens_at_the_floor() {
	let state = remembered(10, 10, 320, 240);
	let (bounds, _) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert_eq!(
		f32::from(bounds.size.width),
		MIN_WIDTH,
		"a size below what the shell draws at is raised to it"
	);
	assert_eq!(f32::from(bounds.size.height), MIN_HEIGHT);
}

#[test]
fn a_window_left_maximised_comes_back_maximised() {
	let mut state = remembered(220, 140, 1480, 920);
	state.window.maximized = true;
	let (bounds, maximized) = placement(&state, &[primary()], MIN_WIDTH, MIN_HEIGHT);
	assert!(maximized);
	assert_eq!(
		f32::from(bounds.size.width),
		1480.0,
		"the bounds it returns to when unmaximised are the ones it had"
	);
}

/// A keeper remembering `session` as the last active one.
fn keeper_remembering(session: Option<&str>) -> Keeper {
	let mut loaded = PersistedState::new();
	loaded.shell.active_session = session.map(SessionId::from);
	Keeper::new(StateDir::at(std::path::PathBuf::from("/nonexistent")), loaded)
}

/// A store holding one session the host listed.
fn store_listing(id: &str) -> Store {
	let mut store = Store::new();
	store
		.sessions
		.insert(support::session(id, QueuePartition::Live));
	store
}

#[test]
fn a_remembered_session_the_host_still_has_is_asked_for_once() {
	let mut keeper = keeper_remembering(Some("session-1"));
	let mut store = store_listing("session-1");
	assert_eq!(
		keeper.resolve_reopen(&mut store),
		Some(SessionId::from("session-1")),
		"the session the last window had open is asked for"
	);
	assert_eq!(
		keeper.resolve_reopen(&mut store),
		None,
		"a second listing does not reopen it under an operator who moved on"
	);
}

#[test]
fn nothing_is_asked_for_before_the_host_has_listed_what_it_has() {
	let mut keeper = keeper_remembering(Some("session-1"));
	let mut store = Store::new();
	assert_eq!(
		keeper.resolve_reopen(&mut store),
		None,
		"an empty list is a list that has not arrived, not a session that is gone"
	);
	let mut listed = store_listing("session-1");
	assert_eq!(
		keeper.resolve_reopen(&mut listed),
		Some(SessionId::from("session-1")),
		"the question is still asked once the list arrives"
	);
}

#[test]
fn a_remembered_session_the_host_no_longer_has_is_dropped_not_reopened() {
	let mut keeper = keeper_remembering(Some("session-gone"));
	let mut store = store_listing("session-1");
	store.persisted.shell.active_session = Some(SessionId::from("session-gone"));
	assert_eq!(
		keeper.resolve_reopen(&mut store),
		None,
		"a session the host does not list is not opened"
	);
	assert_eq!(
		store.persisted.shell.active_session, None,
		"and it stops being the window's active session, to be re-resolved from the protocol"
	);
}

#[test]
fn a_window_that_remembers_no_session_asks_for_none() {
	let mut keeper = keeper_remembering(None);
	let mut store = store_listing("session-1");
	assert_eq!(keeper.resolve_reopen(&mut store), None);
	assert_eq!(
		store.persisted.shell.active_session, None,
		"a window with nothing to reopen leaves the host's own choice alone"
	);
}
