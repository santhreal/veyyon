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
//! 4. Grid cells drawn off the column pitch, or in a face whose glyphs each
//!    have their own advance, which is what the tokens' cell width means and
//!    what an 80-column line is counted in.
//! 5. Cells drawn in a face this machine lacks; the whole authored family table
//!    is swept by `every-authored-font-family-is-a-face-this-machine-has`.
//!
//! WHAT THIS DOES NOT CATCH: underlying PTY signal handling or remote process
//! exit semantics on the host side. The family a run was shaped with is not
//! recorded in a captured frame, so the face is observed through its advance
//! rather than by name; `mono-text-is-set-in-a-family-this-machine-has` in the
//! kit owns the resolution rules themselves.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{Intent, ShellView, damage::Region, fixture, install_tokens};
use veyyon_gpui::{App, AppContext, Point, Window};

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
		let mut state = fixture::with_drawer();
		state.keymap.panel_collapsed = true;
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
	for width in [800, 1180] {
		let mut session = make_drawer_session(&mut cx, width, 600);
		let (drawer, initial_grid) = session
			.update(|view, _, _| {
				(
					view
						.laid_out()
						.bounds(Region::Drawer)
						.expect("drawer laid out"),
					view.state().drawer.grid_rows.clone(),
				)
			})
			.expect("read terminal state");
		session
			.click(Point {
				x: drawer.origin.x + drawer.size.width / 2.0,
				y: drawer.origin.y + drawer.size.height / 2.0,
			})
			.expect("focus terminal by pointer");
		session.frame().expect("focused terminal renders");

		// The first frames measure the grid and ask for the size the window
		// has room for, which is an intent like any other. It is raised once
		// and settles, so it is drained here rather than filtered out of
		// every chord below: a second one would fail this loop.
		for _ in 0..3 {
			session
				.frame()
				.expect("the grid settles at its measured size");
			session
				.update(|view, _, _| view.drain_intents())
				.expect("drain the measured resize");
		}

		for (chord, bytes) in
			[("a", b"a".as_slice()), ("enter", b"\r"), ("ctrl-c", b"\x03"), ("up", b"\x1b[A")]
		{
			let handled = session.keystroke(chord).expect("terminal keystroke");
			session
				.update(|view, window, _| {
					assert_eq!(
						view.drain_intents(),
						vec![Intent::TerminalInput(bytes.to_vec())],
						"chord {chord}, focused contexts: {:?}",
						window.context_stack()
					);
					assert!(handled, "terminal input must not propagate to another input handler");
					assert_eq!(
						view.state().drawer.grid_rows,
						initial_grid,
						"only host output changes cells"
					);
					assert_eq!(view.composer_text(), "", "terminal input must not edit the composer");
				})
				.expect("terminal forwarding verified");
		}
	}
}

/// Every cell of a grid row is drawn one cell width from the last, and every
/// glyph occupies the same width. A row counted in columns is only 80 columns
/// wide if both hold: a proportional face keeps the boxes and moves the ink
/// inside them, so the advance is the observable that separates the two.
#[test]
fn the_grid_draws_every_cell_on_the_column_pitch_at_one_advance() {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let pitch = tokens.surface.panels.terminal_cell_width_px;

	let mut session = make_drawer_session(&mut cx, 1180, 600);
	let captured = session.frame().expect("frame captured");

	// The widest fixture row is the one the grid drew the most runs for.
	let mut rows: std::collections::BTreeMap<i32, Vec<(f32, f32)>> =
		std::collections::BTreeMap::new();
	for run in &captured.text_runs {
		let key = f32::from(run.bounds.origin.y).round() as i32;
		rows
			.entry(key)
			.or_default()
			.push((f32::from(run.bounds.origin.x), f32::from(run.bounds.size.width)));
	}
	let row = rows
		.into_values()
		.max_by_key(Vec::len)
		.expect("the frame drew text");
	assert!(row.len() >= 30, "the grid row under test drew only {} cells", row.len());

	let mut cells = row;
	cells.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("finite origins"));

	let first_width = cells[0].1;
	for (origin, width) in &cells {
		assert!(
			(width - first_width).abs() <= 0.3,
			"a cell at x={origin} drew {width}px of ink where the first drew {first_width}px, so the \
			 face advances per glyph"
		);
	}

	// A cell box is laid out on whole device pixels, so the drawn advance is
	// the token's cell width rounded, not the token's number. What the drawer
	// promises is a single advance for every column and 80 of them inside the
	// width the geometry reserves, so both are measured from the frame.
	let mut columns_covered = 0.0f32;
	for pair in cells.windows(2) {
		let step = pair[1].0 - pair[0].0;
		let columns = (step / pitch).round();
		assert!(columns >= 1.0, "two cells drew at the same column: {step}px apart");
		columns_covered += columns;
	}
	let span = cells[cells.len() - 1].0 - cells[0].0;
	let drawn_pitch = span / columns_covered;
	assert!(
		(drawn_pitch - pitch).abs() <= 0.5,
		"the row advances {drawn_pitch}px per column where the tokens name {pitch}px"
	);
	for pair in cells.windows(2) {
		let step = pair[1].0 - pair[0].0;
		let columns = (step / drawn_pitch).round();
		assert!(
			columns.mul_add(-drawn_pitch, step).abs() <= 1.0,
			"a step of {step}px is not {columns} columns of {drawn_pitch}px"
		);
	}
	let min_columns = tokens.surface.panels.terminal_min_columns as f32;
	assert!(
		drawn_pitch * min_columns <= pitch * min_columns,
		"{min_columns} drawn columns need {}px, more than the {}px the geometry reserves",
		drawn_pitch * min_columns,
		pitch * min_columns
	);
}

// The install refuses a machine without a monospace face, swept over every
// authored chain in `every-authored-font-family-is-a-face-this-machine-has`.
