//! WHY: a terminal drawn at one size and told it is another size is wrong in
//! both directions at once. The shell wraps its output at a column the window
//! does not have, so a line breaks in the middle of the drawer with empty
//! space to its right, and a full-screen program draws its status line at a
//! row nobody can see. The grid was a constant 80x24 here, and no measure
//! reached it: the drawer could be twice that wide and the emulator never
//! heard.
//!
//! CLASS CLOSED:
//! 1. The grid at a size the drawn box does not have, at any window size or in
//!    either drawer placement.
//! 2. A measure taken from arithmetic beside the renderer rather than from the
//!    box the frame drew, which is how the count drifts from the pixels.
//! 3. A window whose geometry changes -- the rail collapsing, the panel opening
//!    -- leaving the grid at the size it had before.
//! 4. A settled window asking for a resize every frame, which would send the
//!    host a `ResizeTerminal` forever and re-break the text under the operator
//!    while they read it.
//! 5. A box too small for a terminal driving the grid below the floor the
//!    tokens declare, which is what makes a narrow window unreadable rather
//!    than merely cramped.
//!
//! WHAT THIS DOES NOT CATCH: whether the text re-breaks correctly at the new
//! width, which is the emulator's and is owned by
//! `output-is-broken-again-when-the-grid-changes-width` in the model, and
//! whether the host applies the size it is sent, which is the app's.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::text::terminal::cells_that_fit;
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{Intent, ShellView, damage::Region, fixture, install_tokens};
use veyyon_gpui::{App, AppContext, Window};

/// Frames to run before a measure is read.
///
/// The first frame lays the grid out, the second carries the measure out as
/// an intent, and the third is the settled window the assertions are made
/// against.
const SETTLE_FRAMES: usize = 3;

fn drawer_session(cx: &mut Headless, width: u32, height: u32) -> HeadlessSession<'_, ShellView> {
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

/// Runs frames until the measure has been taken and applied, and returns
/// every `ResizeTerminal` raised along the way.
fn settle(session: &mut HeadlessSession<'_, ShellView>) -> Vec<(u16, u16)> {
	let mut asked = Vec::new();
	for _ in 0..SETTLE_FRAMES {
		session.frame().expect("a frame renders");
		let drained = session
			.update(|view, _, _| view.drain_intents())
			.expect("intents drain");
		asked.extend(drained.into_iter().filter_map(|intent| match intent {
			Intent::ResizeTerminal { cols, rows } => Some((cols, rows)),
			_ => None,
		}));
	}
	asked
}

/// The cells the drawn grid box has room for, by the same tokens the shell
/// measures with.
fn cells_the_box_holds(session: &mut HeadlessSession<'_, ShellView>) -> (u16, u16) {
	session
		.update(|view, _, _| {
			let bounds = view
				.laid_out()
				.drawn_bounds(Region::TerminalGrid)
				.expect("the grid was laid out");
			let panels = &view.installed().surface.panels;
			let floor = (
				u16::try_from(panels.terminal_min_columns).expect("the column floor is a u16"),
				u16::try_from(panels.terminal_min_rows).expect("the row floor is a u16"),
			);
			cells_that_fit(
				f32::from(bounds.size.width),
				f32::from(bounds.size.height),
				panels.terminal_cell_width_px,
				panels.terminal_cell_height_px,
				floor,
			)
		})
		.expect("the grid box is read")
}

fn grid_cells(session: &mut HeadlessSession<'_, ShellView>) -> (u16, u16) {
	session
		.update(|view, _, _| view.state().drawer.grid_cells)
		.expect("the grid size is read")
}

#[test]
fn the_grid_is_the_size_of_the_box_the_frame_drew_it_in() {
	let mut cx = headless_context().expect("headless context available");

	for (width, height) in [(800, 600), (1180, 800), (1440, 900)] {
		let mut session = drawer_session(&mut cx, width, height);
		settle(&mut session);

		let held = cells_the_box_holds(&mut session);
		assert_eq!(
			grid_cells(&mut session),
			held,
			"at {width}x{height} the grid is the size of its drawn box"
		);
		assert_ne!(
			held,
			(80, 24),
			"at {width}x{height} the grid is measured rather than left at the old constant"
		);
	}
}

#[test]
fn a_settled_window_asks_for_no_further_resize() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = drawer_session(&mut cx, 1180, 800);
	settle(&mut session);

	for frame in 0..6 {
		session.frame().expect("a frame renders");
		let raised: Vec<Intent> = session
			.update(|view, _, _| view.drain_intents())
			.expect("intents drain");
		assert!(
			!raised
				.iter()
				.any(|intent| matches!(intent, Intent::ResizeTerminal { .. })),
			"frame {frame} of a window nobody touched asked for a resize: {raised:?}"
		);
	}
}

#[test]
fn the_measure_is_asked_for_once_and_carries_the_size_the_box_holds() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = drawer_session(&mut cx, 1180, 800);

	let asked = settle(&mut session);
	assert_eq!(asked.len(), 1, "the opening window asked for one resize: {asked:?}");
	assert_eq!(
		asked[0],
		cells_the_box_holds(&mut session),
		"the resize carried the cells the drawn box holds"
	);
}

#[test]
fn a_window_whose_geometry_changes_asks_again_at_the_new_size() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = drawer_session(&mut cx, 1180, 800);
	settle(&mut session);
	let before = grid_cells(&mut session);

	// Collapsing the rail gives its column back to the session surface, and
	// the drawer is inside it: the operator did nothing to the terminal and
	// the terminal is wider.
	session
		.update(|view, _, cx| view.dispatch(Intent::ToggleQueue, cx))
		.expect("the rail collapses");
	let asked = settle(&mut session);

	let after = grid_cells(&mut session);
	assert_eq!(asked.len(), 1, "the changed geometry asked for one resize: {asked:?}");
	assert_eq!(asked[0], after, "the resize carried the size the grid took");
	assert_eq!(after, cells_the_box_holds(&mut session), "and the box agrees with it");
	assert!(
		after.0 > before.0,
		"the drawer took the rail's column: {} columns before, {} after",
		before.0,
		after.0
	);
}

#[test]
fn a_box_with_no_room_holds_the_floor_the_tokens_declare() {
	let mut cx = headless_context().expect("headless context available");
	let mut session = drawer_session(&mut cx, 640, 420);
	settle(&mut session);

	let (floor_cols, floor_rows) = session
		.update(|view, _, _| {
			let panels = &view.installed().surface.panels;
			(panels.terminal_min_columns, panels.terminal_min_rows)
		})
		.expect("the floor is read");
	let (cols, rows) = grid_cells(&mut session);

	assert!(
		usize::from(cols) >= floor_cols,
		"a narrow window kept {floor_cols} columns, not {cols}"
	);
	assert!(usize::from(rows) >= floor_rows, "a short window kept {floor_rows} rows, not {rows}");
}
