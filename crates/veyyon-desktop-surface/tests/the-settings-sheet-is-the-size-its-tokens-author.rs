//! WHY: the settings sheet was `860.0` and `560.0` written into the render
//! (`shell/float.rs`), and the sheet an operator actually reaches -- every path
//! routes a page -- was drawn in the command palette's box instead of its own,
//! with no edge of its own against the scrim. §9.3 rests the iteration loop on
//! a visual measure being authored in a token file and read from it: a measure
//! compiled in is invisible to a sweep of the file, and a surface drawn in
//! another surface's box follows a token nobody edited for it.
//!
//! CLASS CLOSED: a settings sheet sized or inked by anything but its own
//! tokens. Each arm renders the overlay the way the palette opens it, reads the
//! sheet's box back out of the frame, and renders again under edited tokens, so
//! a literal restored to the render fails. One arm edits the palette's width
//! alone and requires the sheet not to move, which is the defect this suite was
//! extended for; another renders a state carrying no route and requires the
//! same box, so the surface has one drawing and not a reachable one beside a
//! dead twin.
//!
//! Held shut against: a literal returning to either measure; a sheet sized off
//! the viewport, which passes at one window size and fails at every other; a
//! sheet that states its own box inside the one the float already sized; a
//! sheet reading the palette's width, the history sheet's width, or any other
//! surface's; and an edge left in the default border colour, which is
//! transparent, since the arm reads the border's own width and alpha rather
//! than whether a box is there.
//!
//! NOT CAUGHT: the clamp against a viewport too small to hold the authored
//! sheet, which
//! `the-rail-footer-gear-is-reachable-at-every-width-that-draws-a-rail` reaches
//! from the other side, and what the sheet draws inside itself, which the row
//! and page suites own.

use std::path::Path;

use veyyon_desktop_kit::{StrokeStep, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	BoxBounds, Captured, HeadlessSession, headless::RenderOptions, headless_context,
};
use veyyon_desktop_surface::{
	Overlay, SettingsPage, SettingsState, ShellView, fixture, install_tokens,
	navigation::SurfaceRoute,
};
use veyyon_desktop_tokens::Tokens;
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// Wide and tall enough that both arms take their authored measures rather
/// than the room the viewport leaves.
const WINDOW_W: u32 = 1440;
const WINDOW_H: u32 = 900;

/// The measures chosen here, which no shipped token file states: an arm that
/// passes at these values is reading the file.
const OTHER_SHEET_W: f32 = 704.0;
const OTHER_SHEET_H: f32 = 448.0;

/// The sheet the destination draws in, taken from the frame by where it sits
/// rather than by how big it is.
///
/// The sheet is the one box the window centres horizontally without spanning
/// it: the rail and the session surface are offset columns, and the scrim and
/// the titlebar span the whole width. Measuring by position leaves the size
/// free to be asserted.
fn sheet(frame: &Captured, window_w: f32) -> Bounds<Pixels> {
	let mut centred: Vec<Bounds<Pixels>> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			let width = f32::from(rect.size.width);
			let centre = f32::from(rect.origin.x) + width / 2.0;
			width < window_w - 1.0 && (centre - window_w / 2.0).abs() < 1.0
		})
		.collect();
	centred.sort_by(|a, b| {
		let area = |rect: &Bounds<Pixels>| f32::from(rect.size.width) * f32::from(rect.size.height);
		area(b)
			.partial_cmp(&area(a))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	centred
		.first()
		.copied()
		.unwrap_or_else(|| panic!("the window centres a sheet it does not span"))
}

/// Renders the shell with `overlay` open under `tokens` and hands back
/// everything the frame recorded.
fn render(tokens: Tokens, overlay: Overlay) -> Captured {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the tokens and theme install");
		app.new(|_| {
			let mut shell = fixture::populated();
			shell.overlay = Some(overlay);
			ShellView::new(installed, shell)
		})
	})
	.expect("the shell opens offscreen");
	session.frame().expect("the destination renders")
}

/// Renders the shell with `overlay` open under `tokens` and returns the box
/// the sheet drew in.
fn sheet_box(tokens: Tokens, overlay: Overlay) -> Bounds<Pixels> {
	sheet(&render(tokens, overlay), WINDOW_W as f32)
}

/// The width and height of the sheet, as the frame recorded them.
fn measures(bounds: Bounds<Pixels>) -> (f32, f32) {
	(f32::from(bounds.size.width), f32::from(bounds.size.height))
}

/// The painted box that fills the sheet: the sheet's own drawing, inside the
/// box the float sized for it.
fn sheet_fill(frame: &Captured, sheet: Bounds<Pixels>) -> &veyyon_desktop_scene::LayoutBox {
	let left = f32::from(sheet.origin.x);
	let top = f32::from(sheet.origin.y);
	let (width, height) = measures(sheet);
	frame
		.layout
		.painted_boxes()
		.find(|painted| {
			let b: BoxBounds = painted.bounds;
			(b.left - left).abs() < 1.0
				&& (b.top - top).abs() < 1.0
				&& (b.width() - width).abs() < 1.0
				&& (b.height() - height).abs() < 1.0
		})
		.unwrap_or_else(|| panic!("the sheet paints nothing in the box the float sized"))
}

/// One page, reached the way the command palette routes to it.
fn routed_page() -> Overlay {
	let mut state = SettingsState::new(SettingsPage::Themes);
	state.route = Some(SurfaceRoute::Page(SettingsPage::Themes));
	Overlay::Settings(Box::new(state))
}

/// A settings state a caller built without routing to it.
fn unrouted() -> Overlay {
	Overlay::Settings(Box::new(SettingsState::new(SettingsPage::General)))
}

#[test]
fn the_sheet_takes_the_width_and_height_the_settings_tokens_author() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let authored = shipped.surface.settings.clone();
	let drawn = sheet_box(shipped.clone(), routed_page());
	assert_eq!(
		measures(drawn),
		(authored.group_width_px, authored.sheet_height_px),
		"the settings sheet draws the box its tokens state"
	);

	let mut other = shipped;
	other.surface.settings.group_width_px = OTHER_SHEET_W;
	other.surface.settings.sheet_height_px = OTHER_SHEET_H;
	let moved = sheet_box(other, routed_page());
	assert_eq!(
		measures(moved),
		(OTHER_SHEET_W, OTHER_SHEET_H),
		"editing the token file resizes the sheet, so neither measure is compiled in"
	);
}

#[test]
fn the_sheet_is_not_drawn_in_the_palette_box() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let authored = shipped.surface.settings.clone();
	assert_ne!(
		shipped.surface.palette.width_px, authored.group_width_px,
		"the palette and the sheet must state different widths for this arm to read anything"
	);

	let mut other = shipped;
	other.surface.palette.width_px = OTHER_SHEET_W;
	let drawn = sheet_box(other, routed_page());
	assert_eq!(
		measures(drawn),
		(authored.group_width_px, authored.sheet_height_px),
		"the palette's width moved and the sheet did not, so the sheet reads its own token"
	);
}

#[test]
fn a_state_with_no_route_draws_the_same_sheet_as_a_routed_one() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let routed = sheet_box(shipped.clone(), routed_page());
	let plain = sheet_box(shipped, unrouted());
	assert_eq!(
		measures(plain),
		measures(routed),
		"a settings state draws one sheet however it was reached"
	);
}

#[test]
fn the_sheet_inks_its_own_edge_against_the_scrim() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let hairline = shipped.scale.stroke(StrokeStep::Hairline);
	let frame = render(shipped, routed_page());
	let drawn = sheet(&frame, WINDOW_W as f32);
	let border = sheet_fill(&frame, drawn)
		.border
		.unwrap_or_else(|| panic!("the sheet draws no border around itself"));
	assert_eq!(border.width, hairline, "the sheet's edge is the hairline stroke its tokens state");
	assert!(
		!border.color.is_invisible(),
		"the sheet's edge is transparent, so it has no boundary against the scrim"
	);
}
