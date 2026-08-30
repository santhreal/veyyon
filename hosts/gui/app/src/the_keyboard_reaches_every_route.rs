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

use crate::{
	keys,
	shell::Shell,
	state::model::{Message, Route, SettingsPage},
};

/// The modifier the table's `secondary-` rows resolve to on this platform. A
/// keystroke is simulated as the platform produces it.
const SECONDARY: &str = if cfg!(target_os = "macos") {
	"cmd"
} else {
	"ctrl"
};

/// A window with the key table bound, as `main` builds it.
fn open(cx: &mut TestAppContext) -> (Entity<Shell>, &mut VisualTestContext) {
	cx.update(|cx| cx.bind_keys(keys::bindings()));
	cx.add_window_view(Shell::new)
}

/// Every route the window draws, from the source of the route type rather than
/// a list written here: a settings page added to `SettingsPage::ALL` is swept
/// the moment it exists.
fn routes() -> Vec<Route> {
	let mut routes = vec![Route::Chat];
	routes.extend(SettingsPage::ALL.map(Route::Settings));
	routes
}

#[gpui::test]
fn every_route_takes_a_keystroke(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	for route in routes() {
		shell.update(cx, |shell, _| shell.store.route = route);
		let before = shell.read_with(cx, |shell, _| shell.store.settings.sidebar_open);

		cx.simulate_keystrokes(&format!("{SECONDARY}-b"));

		let after = shell.read_with(cx, |shell, _| shell.store.settings.sidebar_open);
		assert_ne!(after, before, "{route:?} took no keystroke");
	}
}

#[gpui::test]
fn the_composer_takes_the_keyboard_back_when_the_settings_pages_close(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.simulate_keystrokes(&format!("{SECONDARY}-,"));
	assert!(shell.read_with(cx, |shell, _| !matches!(shell.store.route, Route::Chat)));

	cx.simulate_keystrokes("escape");
	cx.simulate_input("after");

	assert_eq!(text(&shell, cx), "after");
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

	cx.simulate_keystrokes(&format!("{SECONDARY}-k"));
	assert!(
		shell.read_with(cx, |shell, _| shell.store.overlay.is_open()),
		"the palette stayed shut"
	);

	cx.simulate_keystrokes("down down");
	assert_eq!(selected(&shell, cx), 2, "the arrow keys went to the caret, not the list");

	cx.simulate_keystrokes("escape");
	assert!(shell.read_with(cx, |shell, _| !shell.store.overlay.is_open()));

	// The draft is still there and still takes typing: closing the overlay hands
	// the keyboard back rather than leaving it on the field that went away.
	cx.simulate_input("!");
	assert_eq!(text(&shell, cx), "a draft!");
}

#[gpui::test]
fn a_send_clears_the_composer_and_leaves_the_keyboard_in_it(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.simulate_input("read the walker");
	cx.simulate_keystrokes("enter");
	cx.run_until_parked();

	shell.read_with(cx, |shell, _| {
		let session = shell
			.store
			.selected_session()
			.expect("a conversation is open");
		assert_eq!(
			session.messages.last().map(Message::text).as_deref(),
			Some("read the walker"),
			"the send reached no conversation"
		);
		assert_eq!(session.title, "read the walker", "the send did not name the conversation");
	});
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
	shell.read_with(cx, |shell, cx| shell.composer.read(cx).text().to_owned())
}

fn selected(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> usize {
	shell.read_with(cx, |shell, _| {
		shell
			.store
			.overlay
			.palette()
			.expect("the palette is open")
			.selected
	})
}
