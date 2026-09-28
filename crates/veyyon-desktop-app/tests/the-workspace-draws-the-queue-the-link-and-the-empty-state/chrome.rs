//! With no session open the empty state is the window's titlebar: it draws
//! the window controls and a region that moves the window.
//!
//! WHY: the window opens with client-side decorations, so the platform draws
//! no title strip and the thread header is the titlebar while a session is
//! open. With no session open the empty state takes the thread's place, and
//! an empty state with no titlebar row leaves a window whose sidebar is closed
//! with nothing to move it by and no way to minimize, maximize or close it
//! from its own frame.
//!
//! Class: every control the platform reports is drawn in the empty state and
//! the close control closes the window; a press on the empty state's titlebar
//! reaches the platform's window move, not its maximize.
//!
//! Gap: the test platform reports server decorations and has no setter, so
//! the controls are asserted as `window_controls` draws them, which is the
//! same under either. macOS draws its own controls and expects none. The test
//! platform implements no window move, minimize or maximize: each panics, so a
//! move is observed as the panic site the press reaches, compared with the
//! site a direct `start_window_move` reaches. Minimize and maximize are
//! asserted drawn, not pressed, and a double press is not exercised.

use std::{
	cell::Cell,
	panic::{self, AssertUnwindSafe},
	sync::Once,
};

use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext};

use super::{click, drawn, open};

/// Every control the titlebar can draw, by selector.
const CONTROLS: [&str; 3] = ["window.minimize", "window.maximize", "window.close"];

#[test]
fn with_no_session_open_the_empty_state_draws_the_controls_the_platform_reports() {
	let mut cx = TestAppContext::single();
	let (_, _, cx) = open(&mut cx);
	let supported = cx.update(|window, _| window.window_controls());
	let reported = [supported.minimize, supported.maximize, true];
	let expected: Vec<&str> = CONTROLS
		.into_iter()
		.zip(reported)
		.filter(|(_, reported)| !cfg!(target_os = "macos") && *reported)
		.map(|(control, _)| control)
		.collect();
	let controls: Vec<&str> = CONTROLS
		.into_iter()
		.filter(|&control| drawn(cx, control))
		.collect();
	assert_eq!(controls, expected, "the empty state draws every control the platform reports");
	assert!(drawn(cx, "empty-drag-region"), "the empty state draws a region that moves the window");

	if expected.contains(&"window.close") {
		click(cx, "window.close");
		assert!(cx.windows().is_empty(), "the close control closes the window");
	}
}

thread_local! {
	/// Where the last panic on this thread was raised.
	static SITE: Cell<Option<(String, u32)>> = const { Cell::new(None) };
}

/// Runs `act` in a fresh window with no session open and returns where it
/// panicked. The test platform panics in every window operation it does not
/// implement, so the site states which operation `act` reached. The window
/// does not survive the panic, hence one window per call.
fn panic_site(act: impl FnOnce(&mut VisualTestContext)) -> Option<(String, u32)> {
	static HOOK: Once = Once::new();
	HOOK.call_once(|| {
		let previous = panic::take_hook();
		panic::set_hook(Box::new(move |info| {
			SITE.set(info.location().map(|at| (at.file().to_owned(), at.line())));
			previous(info);
		}));
	});
	let mut cx = TestAppContext::single();
	let (_, _, cx) = open(&mut cx);
	cx.update(|window, _| window.refresh());
	SITE.set(None);
	let outcome = panic::catch_unwind(AssertUnwindSafe(|| act(cx)));
	outcome.err().and_then(|_| SITE.take())
}

#[test]
fn a_press_on_the_empty_states_titlebar_starts_a_window_move() {
	let moves = panic_site(|cx| cx.update(|window, _| window.start_window_move()));
	let zooms = panic_site(|cx| cx.update(|window, _| window.zoom_window()));
	assert!(
		moves.is_some(),
		"the test platform panics on a window move; if it records one now, assert the record"
	);
	assert_ne!(moves, zooms, "a window move and a maximize panic at different sites");

	let pressed = panic_site(|cx| {
		let region = cx
			.debug_bounds("empty-drag-region")
			.expect("the empty state draws a region that moves the window");
		cx.simulate_mouse_down(region.center(), MouseButton::Left, Modifiers::none());
	});
	assert_eq!(pressed, moves, "a press on the empty state's titlebar starts a window move");
}
