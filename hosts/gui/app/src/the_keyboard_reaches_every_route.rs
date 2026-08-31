//! WHY THIS SUITE EXISTS. Four defects in this window were the same defect: a
//! keystroke reached nothing because the element holding the keyboard was not
//! where the binding dispatched from. A binding walks up from the focused
//! element, so the window is deaf whenever the focused element left the tree,
//! and it is deaf in a different way when an ancestor takes focus from the
//! field the reader is typing in. Opening the settings pages unmounts the
//! composer; a click on a sidebar row or the composer's own padding lands on a
//! focusable ancestor. Every route the window can be in is
//! swept here, so a new route that draws no text field fails this suite instead
//! of shipping a screen that ignores the keyboard.
//!
//! WHAT IT DOES NOT CATCH. The reveal clock. A frame stamps `now` from the
//! window's own `Instant`, which the test platform's clock does not move, so a
//! reply is proven to start here and proven to arrive in the state suite, which
//! owns time as an argument.
//!
//! A settings page missing from `SettingsPage::ALL`, which is written by hand
//! because a Rust enum cannot be enumerated at run time. Such a page is
//! unreachable in the window as well, since the settings nav draws from the
//! same array, so it fails visibly rather than silently.
//!
//! Nothing about appearance. The window draws into a
//! test platform with no display, so colour, spacing, clipping and what a frame
//! looks like are not observed. Hit testing is exercised only where a click is
//! simulated at a coordinate, and a control that moved out from under that
//! coordinate would still pass.

use gpui::{Entity, Modifiers, Point, TestAppContext, VisualTestContext, px};
use veyyon_gui_core::{
	UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState, SessionId},
	navigation::{Route, SettingsPage},
};

use crate::shell::Shell;

/// The modifier the table's `secondary-` rows resolve to on this platform. A
/// keystroke is simulated as the platform produces it.
pub(crate) const SECONDARY: &str = if cfg!(target_os = "macos") {
	"cmd"
} else {
	"ctrl"
};

/// A window with both key tables bound, as `main` builds it, attached to a host
/// that accepts a turn.
///
/// Attached rather than detached because the boundary refuses every host action
/// while nothing is connected, and a refused send is a send that correctly
/// keeps the text it could not deliver. A suite about the keyboard would
/// otherwise be asserting the refusal path for every chord that reaches the
/// host.
pub(crate) fn open(cx: &mut TestAppContext) -> (Entity<Shell>, &mut VisualTestContext) {
	open_with(cx, attached())
}

/// The same window over a host that reported more than a connection: a surface
/// whose field is drawn only once its replica has arrived needs the arrival.
pub(crate) fn open_with(
	cx: &mut TestAppContext,
	events: Vec<HostEvent>,
) -> (Entity<Shell>, &mut VisualTestContext) {
	cx.update(|cx| {
		cx.bind_keys(veyyon_gui_features::act::bindings());
		cx.bind_keys(veyyon_gui_kit::input::keys::bindings());
	});
	cx.add_window_view(|window, cx| Shell::with_events(events, window, cx))
}

/// What a host reports once it is up: connected, and every capability the
/// window asks about available. Read from `Capability` itself, so a capability
/// added later is available here too rather than turning a keyboard test red.
pub(crate) fn attached() -> Vec<HostEvent> {
	vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "test".to_owned(),
			protocol: 1,
		}),
		HostEvent::Snapshot(SnapshotSection::Capabilities(
			Capability::ALL
				.iter()
				.map(|capability| (*capability, CapabilityStatus::Available))
				.collect(),
		)),
	]
}

/// Every route the window draws, from the source of the route type rather than
/// a list written here: a settings page added to `SettingsPage::ALL` is swept
/// the moment it exists.
fn routes() -> Vec<Route> {
	let mut routes = vec![Route::Conversation, Route::Changes, Route::Files, Route::Agents];
	routes.extend(SettingsPage::ALL.map(Route::Settings));
	routes
}

/// Reach a route the way the window reaches it. A route written straight into
/// the store is a state no keystroke can produce, and it leaves the keyboard on
/// the field the old route drew: placing it again is the transition's job, so a
/// test that skips the transition is testing a window that cannot exist.
fn navigate(shell: &Entity<Shell>, route: Route, cx: &mut VisualTestContext) {
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| shell.perform(UiCommand::Navigate(route), window, cx));
	});
}

#[gpui::test]
fn every_route_takes_a_keystroke(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	for route in routes() {
		navigate(&shell, route, cx);
		let before = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);

		cx.simulate_keystrokes(&format!("{SECONDARY}-b"));

		let after = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);
		assert_ne!(after, before, "{route:?} took no keystroke");
	}
}

#[gpui::test]
fn no_command_in_the_table_leaves_the_window_deaf(cx: &mut TestAppContext) {
	// The class, not the incident: every one of the four defects this suite is
	// named for was a command that moved the keyboard onto an element nothing
	// draws, and the window then answered nothing at all. Swept from the key
	// table itself, so a command added to it is proven here or fails here.
	for row in veyyon_gui_core::keys::table() {
		let (shell, cx) = open(cx);
		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| shell.perform(row.command.clone(), window, cx));
		});

		let before = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);
		cx.simulate_keystrokes(&format!("{SECONDARY}-b"));
		let after = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);

		assert_ne!(after, before, "{:?} left the window deaf", row.command);
	}
}

#[gpui::test]
fn the_composer_takes_the_keyboard_back_when_the_settings_pages_close(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.simulate_keystrokes(&format!("{SECONDARY}-,"));
	assert!(
		shell.read_with(cx, |shell, _| !matches!(shell.store.frontend.route, Route::Conversation))
	);
	cx.simulate_keystrokes("escape");
	cx.simulate_input("after");

	assert_eq!(text(&shell, cx), "after");
}

#[gpui::test]
fn the_arrow_keys_walk_the_settings_pages_and_the_composer_keeps_its_own(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	cx.simulate_input("a draft");

	// In a conversation the arrows belong to the caret, and the window's own
	// binding for them has to stay out of the way: this asserts the draft
	// survives, which it would not if an arrow reached a command that changed
	// the route or the conversation.
	cx.simulate_keystrokes("up down");
	assert_eq!(text(&shell, cx), "a draft");
	assert!(
		shell.read_with(cx, |shell, _| matches!(shell.store.frontend.route, Route::Conversation))
	);

	cx.simulate_keystrokes(&format!("{SECONDARY}-,"));
	let opened = shell.read_with(cx, |shell, _| shell.store.frontend.route);
	cx.simulate_keystrokes("down");
	let moved = shell.read_with(cx, |shell, _| shell.store.frontend.route);
	assert_ne!(moved, opened, "the arrow keys do not reach the page list");

	cx.simulate_keystrokes("up");
	assert_eq!(
		shell.read_with(cx, |shell, _| shell.store.frontend.route),
		opened,
		"walking back did not arrive where it started"
	);

	// And the draft is still there once settings close, so nothing the arrows
	// did touched the field.
	cx.simulate_keystrokes("escape");
	assert_eq!(text(&shell, cx), "a draft");
}

#[gpui::test]
fn a_click_on_chrome_leaves_the_keyboard_in_the_composer(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	cx.simulate_input("before");

	// The transcript, which is chrome: it holds no field, and the window root
	// under it is focusable.
	cx.simulate_click(Point { x: px(700.0), y: px(300.0) }, Modifiers::none());
	cx.simulate_input(" after");

	assert_eq!(text(&shell, cx), "before after");
}

#[gpui::test]
fn the_palette_opens_and_walks_while_the_composer_holds_the_keyboard(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	cx.simulate_input("a draft");

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	assert!(
		shell.read_with(cx, |shell, _| !shell.store.frontend.overlays.is_empty()),
		"the palette stayed shut"
	);

	cx.simulate_keystrokes("down down");
	assert_eq!(selected(&shell, cx), 2, "the arrow keys went to the caret, not the list");

	cx.simulate_keystrokes("escape");
	assert!(shell.read_with(cx, |shell, _| shell.store.frontend.overlays.is_empty()));
	// The draft is still there and still takes typing: closing the overlay hands
	// the keyboard back rather than leaving it on the field that went away.
	cx.simulate_input("!");
	assert_eq!(text(&shell, cx), "a draft!");
}

#[gpui::test]
fn a_route_change_behind_the_palette_leaves_the_keyboard_in_it(cx: &mut TestAppContext) {
	// The route's field is not the one on screen while an overlay is open, so
	// the placement a route change does has to stand down. A palette that lost
	// the keyboard to the route it just navigated to would take one keystroke
	// and then stop taking them.
	let (shell, cx) = open(cx);
	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	navigate(&shell, Route::Files, cx);
	assert!(
		shell.read_with(cx, |shell, _| !shell.store.frontend.overlays.is_empty()),
		"the palette closed on its own"
	);

	cx.simulate_input("walk");

	assert_eq!(
		shell.read_with(cx, |shell, cx| shell.handles.editors.command.read(cx).text().to_owned()),
		"walk",
		"the palette's field lost the keyboard to the route behind it"
	);
}

#[gpui::test]
fn a_chord_that_changes_no_route_leaves_the_keyboard_where_it_is(cx: &mut TestAppContext) {
	// The other half of the placement rule. A route change replaces every field
	// at once and has to place the keyboard again; every other command replaces
	// nothing, and a reader who pressed a chord while typing in a filter keeps
	// typing into that filter. Placing it on each command instead would move the
	// keyboard to the composer under the reader's hands.
	let (shell, cx) = open(cx);
	let filter = shell.read_with(cx, |shell, _| shell.handles.editors.sessions.clone());
	cx.update(|window, cx| veyyon_gui_kit::input::Editor::focus(&filter, window, cx));
	cx.simulate_input("walk");

	// Reduced motion: a command in the table that draws no field away.
	cx.simulate_keystrokes(&format!("{SECONDARY}-shift-m"));
	cx.simulate_input("er");

	assert_eq!(
		filter.read_with(cx, |filter, _| filter.text().to_owned()),
		"walker",
		"a chord moved the keyboard out of the filter"
	);
	assert_eq!(text(&shell, cx), "", "the keyboard landed in the composer");
}

#[gpui::test]
fn a_press_beside_the_palette_lands_on_its_ground(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	assert!(shell.read_with(cx, |shell, _| !shell.store.frontend.overlays.is_empty()));
	// The ground covers the window, so a press in a corner is a press on it.
	// An overlay laid out inside a box of no size is hit by nothing and drawn
	// nowhere, which is what this coordinate proves it is not: the press is far
	// from the panel and far from anything else that closes the palette.
	cx.simulate_click(Point { x: px(30.0), y: px(600.0) }, Modifiers::none());

	assert!(
		shell.read_with(cx, |shell, _| shell.store.frontend.overlays.is_empty()),
		"the press missed the sheet: its ground is not covering the window"
	);
}

#[gpui::test]
fn a_send_clears_the_composer_and_leaves_the_keyboard_in_it(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	let session = SessionId::new("test-session").expect("session id is not empty");
	shell.update(cx, |shell, _| shell.store.frontend.selected_session = Some(session));

	cx.simulate_input("read the walker");
	cx.simulate_keystrokes("enter");
	cx.run_until_parked();

	assert_eq!(text(&shell, cx), "", "the composer kept the sent text");

	cx.simulate_input("again");
	assert_eq!(text(&shell, cx), "again", "the composer lost the keyboard to the send");
}

#[gpui::test]
fn the_window_opens_with_the_keyboard_in_the_composer(cx: &mut TestAppContext) {
	// Nothing is clicked and no route is set: a window that opens deaf makes
	// every other test here pass by accident.
	let (shell, cx) = open(cx);
	cx.simulate_input("straight in");
	assert_eq!(text(&shell, cx), "straight in");
}

fn text(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
	shell.read_with(cx, |shell, cx| shell.handles.editors.composer.read(cx).text().to_owned())
}

fn selected(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> usize {
	shell.read_with(cx, |shell, _| shell.store.frontend.palette_cursor)
}
