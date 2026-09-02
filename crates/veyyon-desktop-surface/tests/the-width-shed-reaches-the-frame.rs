//! WHY: `shell_widths` can be right while the frame is wrong, because a region
//! that ignores the width it is handed still renders. At the declared 800x560
//! floor the session surface resolved to nothing, and the frame was the queue
//! rail and the right panel meeting in the middle. These assertions read the
//! rendered pixels at that floor and check that each region's edge is where the
//! shed put it.
//!
//! THE CLASS THIS CLOSES: a region drawing at a measure other than the one the
//! shed resolved — a hardcoded width, a default that outranks its argument, an
//! overlay that docks. Both placements of the right panel are covered, since an
//! overlay that takes width from the session surface is the same defect as an
//! inline column that takes too much, and both placements of the terminal
//! drawer are covered for the same reason in the vertical direction.
//!
//! WHAT IT DOES NOT CATCH: content inside a region, colour fidelity, and
//! anything about height beyond what the two drawer placements decide.

use std::{collections::BTreeMap, path::Path};

use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	frame::{RgbaColor, RgbaFrame},
	headless::{RenderOptions, headless_context, render_view, write_png},
};
use veyyon_desktop_surface::{
	ShellState, ShellView, fixture, install_tokens,
	layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths},
};
use veyyon_desktop_tokens::DrawerPlacement;
use veyyon_gpui::{App, AppContext};

/// The shed's input for a window, with the same gutter the session column uses.
/// The height matters because the drawer's measure is bounded by a share of it,
/// so it is the height the frame is actually rendered at.
fn shed(viewport_px: f32, viewport_height_px: f32, panel_open: bool) -> ShedInput {
	let gutter_px = f32::from(TokenSet::default().spacing(SpacingStep::S4));
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	ShedInput {
		viewport_px,
		viewport_height_px,
		// These frames carry no attention strip, so the titlebar is all the
		// chrome above the columns row.
		chrome_height_px: surface.shell.titlebar_height_px,
		gutter_px,
		queue_collapsed: false,
		panel_open,
		labels: LabelState::default(),
	}
}

/// The most common colour down a column, sampled between the titlebar and the
/// composer. A single pixel may land on a glyph or a hairline; the mode of a
/// column is the region's ground, which is what a width actually controls.
fn ground_at(frame: &RgbaFrame, x: u32, from_y: u32, to_y: u32) -> RgbaColor {
	let mut counts: BTreeMap<[u8; 4], u32> = BTreeMap::new();
	for y in from_y..to_y {
		let pixel = frame.pixel(x, y).expect("the sample is inside the frame");
		*counts
			.entry([pixel.r, pixel.g, pixel.b, pixel.a])
			.or_default() += 1;
	}
	let (bytes, _) = counts
		.into_iter()
		.max_by_key(|(_, count)| *count)
		.expect("the column has at least one pixel");
	RgbaColor { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes[3] }
}

/// Renders the shell at one window size with one state.
fn render_at(width: u32, height: u32, state: ShellState, name: &str) -> RgbaFrame {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");

	let frame = render_view(
		&mut cx,
		&RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() },
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, state))
		},
	)
	.expect("the shell renders offscreen");

	// Written so the shed can be judged by looking at it, which is the only way
	// a layout decision is actually reviewed.
	write_png(&frame, &Path::new("../../target/scene-frames").join(format!("{name}.png")))
		.expect("the frame is written");
	frame
}

#[test]
fn at_the_window_floor_the_session_surface_spans_the_window() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let width = surface.shell.window_min_width_px as u32;
	let height = surface.shell.window_min_height_px as u32;

	// No right panel content, so nothing competes with the transcript, and
	// no transcript, so the column is its own ground from edge to edge: a
	// user turn paints its own ground and would make the middle column a
	// different colour from the gutter beside it for a reason that has
	// nothing to do with the shed. The window floor also collapses the
	// queue, so the session surface is the whole row.
	let mut state = fixture::populated();
	state.panel = veyyon_desktop_surface::PanelContent::default();
	state.transcript = Vec::new();
	state.cards = Vec::new();
	let widths = shell_widths(shed(width as f32, height as f32, false), &surface);
	assert_eq!(
		widths.right_panel,
		RightPanelPlacement::Absent,
		"the shed placed a panel for a state with no panel content"
	);

	let frame = render_at(width, height, state, "shed-floor-no-panel");
	let titlebar = surface.shell.titlebar_height_px as u32;
	let band = (titlebar + 4, height / 2);

	let start = widths.queue_px.unwrap_or(0.0) as u32;
	let left = ground_at(&frame, start + 4, band.0, band.1);
	let middle = ground_at(&frame, start + (widths.session_px as u32) / 2, band.0, band.1);
	let right = ground_at(&frame, width - 4, band.0, band.1);

	assert_eq!(
		left, middle,
		"the session surface is not one continuous region across the width the shed gave it"
	);
	assert_eq!(
		middle, right,
		"something is drawing at the right edge of a window whose shed placed no panel there"
	);
}

#[test]
fn at_the_window_floor_the_panel_overlays_instead_of_taking_the_transcript() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let width = surface.shell.window_min_width_px as u32;
	let height = surface.shell.window_min_height_px as u32;

	let state = fixture::populated();
	assert!(
		!state.panel.is_empty(),
		"the fixture must have panel content for this to mean anything"
	);

	let widths = shell_widths(shed(width as f32, height as f32, true), &surface);
	let drawn = match widths.right_panel {
		RightPanelPlacement::Overlay { width_px } => width_px,
		other => panic!("the window floor must overlay the panel, not place it {other:?}"),
	};
	assert_eq!(
		widths.session_px,
		width as f32 - widths.queue_px.unwrap_or(0.0),
		"an overlaid panel took width out of the session surface"
	);

	let frame = render_at(width, height, state, "shed-floor-overlay-panel");
	let titlebar = surface.shell.titlebar_height_px as u32;
	let band = (titlebar + 4, height / 2);

	// The overlay's leading edge is at width - drawn. The column just inside it
	// is the panel's ground; the column just outside is the scrim over the
	// session surface, which is a different colour or the overlay is not where
	// the shed put it.
	let edge = width - drawn as u32;
	let inside = ground_at(&frame, edge + 8, band.0, band.1);
	let outside = ground_at(&frame, edge.saturating_sub(8), band.0, band.1);
	let far_right = ground_at(&frame, width - 4, band.0, band.1);

	assert_eq!(inside, far_right, "the overlaid panel is not one ground across its own width");
	assert_ne!(
		inside, outside,
		"the overlaid panel's leading edge is not at {edge}px, where the shed put it"
	);
}

#[test]
fn a_wide_window_docks_the_panel_at_the_width_the_shed_resolved() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let (width, height) = (1440u32, 900u32);

	let widths = shell_widths(shed(width as f32, height as f32, true), &surface);
	let inline = match widths.right_panel {
		RightPanelPlacement::Inline { width_px } => width_px,
		other => panic!("a 1440px window must dock the panel, not place it {other:?}"),
	};
	let queue = widths
		.queue_px
		.expect("a 1440px window keeps the queue rail");

	let frame = render_at(width, height, fixture::populated(), "shed-wide-inline-panel");
	let titlebar = surface.shell.titlebar_height_px as u32;
	let band = (titlebar + 4, height / 2);

	let rail = ground_at(&frame, (queue / 2.0) as u32, band.0, band.1);
	let session = ground_at(&frame, queue as u32 + (widths.session_px as u32) / 2, band.0, band.1);
	let panel_edge = width - inline as u32;
	let panel = ground_at(&frame, panel_edge + 8, band.0, band.1);
	let session_at_edge = ground_at(&frame, panel_edge.saturating_sub(8), band.0, band.1);

	assert_ne!(rail, session, "the queue rail and the session surface share a ground");
	assert_eq!(
		session, session_at_edge,
		"the session surface stops before the width the shed gave it, so the panel is too wide"
	);
	assert_ne!(
		panel, session_at_edge,
		"the docked panel's leading edge is not at {panel_edge}px, where the shed put it"
	);
}

/// One raster row's bytes, for comparing two frames row by row.
fn row(frame: &RgbaFrame, y: u32) -> &[u8] {
	let stride = frame.width() as usize * 4;
	let start = y as usize * stride;
	frame
		.as_bytes()
		.get(start..start + stride)
		.expect("the row is inside the frame")
}

/// The first row at or below `from_y` two frames of the same geometry disagree
/// on. The titlebar is excluded by the caller: its drawer control states the
/// drawer's position, so it changes with the drawer by design and says nothing
/// about whether the column below it moved.
fn first_differing_row(closed: &RgbaFrame, open: &RgbaFrame, from_y: u32) -> Option<u32> {
	(from_y..closed.height()).find(|&y| row(closed, y) != row(open, y))
}

/// The shell at one width with the drawer closed and with it open, which is the
/// The shell at one window size with the drawer closed and with it open, which
/// is the only pair that shows what opening the drawer costs the rows above it.
///
/// The panel content is cleared in both arms: an overlaid right panel draws a
/// blurred scrim across the whole columns row, and a blur reads pixels from
/// outside its own edge, so it would move the first differing row for a reason
/// that has nothing to do with the drawer.
fn drawer_pair(width: u32, height: u32, name: &str) -> (RgbaFrame, RgbaFrame) {
	let mut closed = fixture::with_drawer();
	closed.panel = Default::default();
	closed.drawer_open = false;
	let mut open = fixture::with_drawer();
	open.panel = Default::default();
	(
		render_at(width, height, closed, &format!("{name}-drawer-closed")),
		render_at(width, height, open, &format!("{name}-drawer-open")),
	)
}

#[test]
fn at_the_window_floor_the_drawer_overlays_instead_of_taking_the_transcript() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let width = surface.shell.window_min_width_px as u32;
	let height = surface.shell.window_min_height_px as u32;

	let widths = shell_widths(shed(width as f32, height as f32, false), &surface);
	assert_eq!(
		widths.drawer.placement,
		DrawerPlacement::Overlay,
		"the window floor must overlay the drawer for this test to mean anything"
	);

	let (closed, open) = drawer_pair(width, height, "shed-floor");
	let titlebar = surface.shell.titlebar_height_px as u32;
	let changed = first_differing_row(&closed, &open, titlebar)
		.expect("opening the drawer changed no pixel below the titlebar, so the drawer did not draw");

	// An overlaid drawer draws over the column's lower edge and nothing above
	// it moves. A drawer that docked instead would shorten the column, and the
	// bottom-anchored transcript, the composer and the run bar would all shift
	// up — which is a differing row far above the drawer's own top edge.
	let top = height - widths.drawer.height_px as u32;
	assert!(
		changed >= top.saturating_sub(2),
		"opening an overlaid drawer changed row {changed}, above its own top edge at {top}px: the \
		 drawer took height out of the session column instead of covering it"
	);
}

#[test]
fn a_standard_window_docks_the_drawer_and_the_column_gives_up_the_height() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let width = surface.breakpoints.standard.min_width_px as u32;
	// Tall enough that the transcript still has height after the drawer takes
	// its 280px, so the frame shows a docked drawer rather than a column that
	// overflowed its window.
	let height = 900u32;

	let widths = shell_widths(shed(width as f32, height as f32, false), &surface);
	assert_eq!(
		widths.drawer.placement,
		DrawerPlacement::Row,
		"the standard row must dock the drawer for this test to mean anything"
	);

	// The negative control for the assertion above: where the drawer docks, the
	// rows above its top edge DO change, because the column gave up the height.
	// Without this, an overlay assertion also passes for a drawer that draws
	// nothing at all.
	let (closed, open) = drawer_pair(width, height, "shed-standard");
	let titlebar = surface.shell.titlebar_height_px as u32;
	let changed = first_differing_row(&closed, &open, titlebar)
		.expect("opening the drawer changed no pixel below the titlebar, so the drawer did not draw");
	let top = height - widths.drawer.height_px as u32;
	assert!(
		changed < top,
		"opening a docked drawer changed nothing above its top edge at {top}px (first change at row \
		 {changed}): the column did not give up the height the drawer takes"
	);
}
