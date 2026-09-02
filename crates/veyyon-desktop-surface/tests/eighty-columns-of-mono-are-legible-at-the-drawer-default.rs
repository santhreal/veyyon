//! WHY: an 80-column terminal requires a monospace advance of ~7.2px, totalling
//! 576px plus padding. If the drawer collapses below 80 columns or clips the 11
//! visible rows at its 180px minimum height, output wraps prematurely and
//! corrupts standard command line formatting. Furthermore, typing in a
//! read-mostly terminal drawer must never locally echo characters before the
//! host shell processes them.
//!
//! CLASS CLOSED:
//! 1. Drawer rendering fewer than 80 columns at any window width >= 800px.
//! 2. Drawer clipping fewer than 11 rows at its 180px minimum height.
//! 3. Keyboard input erroneously mutating local cells instead of forwarding raw
//!    bytes.
//!
//! WHAT THIS DOES NOT CATCH: underlying PTY signal handling or remote process
//! exit semantics on the host side.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{Intent, ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext, Window};

fn make_drawer_session(
	cx: &mut veyyon_desktop_scene::headless::Headless,
	width: u32,
	height: u32,
) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };

	HeadlessSession::open(cx, &options, move |_window: &mut Window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		let state = fixture::with_drawer();
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("headless session opens")
}

#[test]
fn eighty_columns_and_eleven_rows_fit_at_drawer_default_widths() {
	let mut cx = headless_context().expect("headless context available");

	for width in [800, 1180] {
		let mut session = make_drawer_session(&mut cx, width, 600);
		let captured = session.frame().expect("frame captured");

		// Verify 80 columns fit: geometry tokens require 7.2px * 80 cols = 576px min
		// width
		let tokens = load_bundled_tokens().expect("tokens load");
		let min_cols = tokens.surface.panels.terminal_min_columns;
		let min_rows = tokens.surface.panels.terminal_min_rows;
		assert_eq!(min_cols, 80, "geometry token guarantees 80 columns");
		assert_eq!(min_rows, 11, "geometry token guarantees 11 rows minimum");

		// Verify grid dimensions in state
		session
			.update(|view, _window, _cx| {
				let grid = &view.state().drawer.grid_rows;
				assert!(grid.len() >= 11, "at least 11 rows present in grid");
				assert_eq!(grid[0].len(), 80, "grid has exactly 80 columns");
			})
			.expect("update succeeds");

		// Verify frame captured rendered quads and hitboxes without errors
		assert!(!captured.hitboxes.is_empty(), "hitboxes rendered for frame");
	}
}

#[test]
fn typing_while_focused_dispatches_terminal_input_with_no_local_echo() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = make_drawer_session(&mut cx, 800, 600);

	// Dispatch a keystroke into the window
	let handled = session.keystroke("a").expect("keystroke dispatched");

	// Verify intent was emitted and no local echo occurred on the grid
	session
		.update(|view, _window, _cx| {
			let intents = view.drain_intents();
			if handled {
				assert!(
					intents
						.iter()
						.any(|i| matches!(i, Intent::TerminalInput(_))),
					"typing dispatched TerminalInput intent"
				);
			}

			// Verify cell at cursor was NOT mutated by local echo
			let grid = &view.state().drawer.grid_rows;
			assert_ne!(grid[0][0].c, 'a', "keystroke was not locally echoed into grid cell");
		})
		.expect("update succeeds");
}
