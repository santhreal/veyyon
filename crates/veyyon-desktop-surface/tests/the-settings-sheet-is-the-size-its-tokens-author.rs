//! WHY: the settings sheet was `860.0` and `560.0` written into the render
//! (`shell/float.rs`), so the one surface every configuration change is made
//! on could not be resized by editing a token file. §9.3 rests the whole
//! iteration loop on the opposite: a visual measure is authored in a token
//! file and read from it, so a sweep of the file moves the window. A measure
//! compiled in is invisible to the sweep, agrees with the authored number
//! only by luck, and drifts from it silently.
//!
//! CLASS CLOSED: a settings sheet sized by anything but its tokens. Each arm
//! renders twice — once at the shipped values and once at values chosen here —
//! and reads the sheet's box back out of the frame, so a number restored to
//! the render, or a token read for one arm and not the other, fails. The
//! sheet is found by its position rather than by its size, so a frame drawing
//! the wrong size is measured and reported rather than missed.
//!
//! Held shut against: a literal returning to any of the three measures; the
//! group sheet and the focused page sharing one measure when the tokens author
//! two; a height that ignores the token while the width follows it; a sheet
//! sized off the viewport, which passes at one window size and fails at every
//! other; a dialog that states its own box inside the one the float already
//! sized, which drifts the moment the token moves; and a sidebar divider left
//! in the default border colour, which is transparent, since the sidebar is
//! found among the boxes that paint ink and an uninked column is not there.
//!
//! NOT CAUGHT: the clamp against a viewport too small to hold the authored
//! sheet, which
//! `the-rail-footer-gear-is-reachable-at-every-width-that-draws-a-rail` reaches
//! from the other side, and what the sheet draws inside the sidebar and the
//! page beside it, which the row and page suites own.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
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
const OTHER_GROUP_W: f32 = 704.0;
const OTHER_SHEET_H: f32 = 448.0;
const OTHER_SIDEBAR_W: f32 = 172.0;

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

/// Every painted box that starts on the sheet's left edge and runs its full
/// height, widest first.
///
/// The dialog and its sidebar are the two: the dialog fills the box the float
/// sized, and the sidebar is the column inside it, inset by the dialog's own
/// hairline on the left and on both ends, which the tolerance here allows for.
/// Selecting them by edge and height leaves both widths free to be asserted.
fn full_height_columns(frame: &Captured, sheet: Bounds<Pixels>) -> Vec<BoxBounds> {
	let left = f32::from(sheet.origin.x);
	let height = f32::from(sheet.size.height);
	let mut columns: Vec<BoxBounds> = frame
		.layout
		.painted_boxes()
		.map(|painted| painted.bounds)
		.filter(|bounds| (bounds.left - left).abs() < 2.0 && (bounds.height() - height).abs() < 4.0)
		.collect();
	columns.sort_by(|a, b| {
		b.width()
			.partial_cmp(&a.width())
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	columns
}

/// The sidebar the group sheet draws down its left edge: the widest full-height
/// column narrower than the sheet, the sheet-wide ones being the dialog's own
/// fill, border and shadow.
fn sidebar_box(frame: &Captured, sheet: Bounds<Pixels>) -> BoxBounds {
	let sheet_w = f32::from(sheet.size.width);
	full_height_columns(frame, sheet)
		.into_iter()
		.find(|bounds| bounds.width() < sheet_w - 1.0)
		.unwrap_or_else(|| panic!("the group sheet draws a sidebar down its left edge"))
}

/// The tabbed group, which is the settings surface with no page routed under
/// it.
fn group() -> Overlay {
	Overlay::Settings(Box::new(SettingsState::new(SettingsPage::General)))
}

/// One page, reached the way the command palette routes to it.
fn focused_page() -> Overlay {
	let mut state = SettingsState::new(SettingsPage::Themes);
	state.route = Some(SurfaceRoute::Page(SettingsPage::Themes));
	Overlay::Settings(Box::new(state))
}

#[test]
fn the_group_sheet_takes_the_width_and_height_the_settings_tokens_author() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let authored = shipped.surface.settings.clone();
	let drawn = sheet_box(shipped.clone(), group());
	assert_eq!(
		(f32::from(drawn.size.width), f32::from(drawn.size.height)),
		(authored.group_width_px, authored.sheet_height_px),
		"the group sheet draws the box its tokens state"
	);

	let mut other = shipped;
	other.surface.settings.group_width_px = OTHER_GROUP_W;
	other.surface.settings.sheet_height_px = OTHER_SHEET_H;
	let moved = sheet_box(other, group());
	assert_eq!(
		(f32::from(moved.size.width), f32::from(moved.size.height)),
		(OTHER_GROUP_W, OTHER_SHEET_H),
		"editing the token file resizes the group sheet, so neither measure is compiled in"
	);
}

#[test]
fn a_focused_page_takes_the_palette_width_and_the_settings_sheet_height() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let palette_w = shipped.surface.palette.width_px;
	let sheet_h = shipped.surface.settings.sheet_height_px;
	let drawn = sheet_box(shipped.clone(), focused_page());
	assert_eq!(
		(f32::from(drawn.size.width), f32::from(drawn.size.height)),
		(palette_w, sheet_h),
		"a routed page is as wide as the palette geometry and as tall as the settings sheet"
	);

	// The group's width is the other arm's measure: a page that followed it
	// would be reading the wrong token, and a page sized off the viewport
	// would follow neither.
	let mut other = shipped;
	other.surface.palette.width_px = OTHER_GROUP_W;
	other.surface.settings.sheet_height_px = OTHER_SHEET_H;
	let moved = sheet_box(other, focused_page());
	assert_eq!(
		(f32::from(moved.size.width), f32::from(moved.size.height)),
		(OTHER_GROUP_W, OTHER_SHEET_H),
		"editing the token files resizes the focused page too"
	);
}

#[test]
fn the_dialog_fills_the_box_the_float_sized_rather_than_stating_a_measure_of_its_own() {
	let mut other = load_bundled_tokens().expect("the bundled tokens load");
	other.surface.settings.group_width_px = OTHER_GROUP_W;
	other.surface.settings.sheet_height_px = OTHER_SHEET_H;
	let frame = render(other, group());
	let drawn = sheet(&frame, WINDOW_W as f32);
	let columns = full_height_columns(&frame, drawn);
	let dialog = columns
		.first()
		.copied()
		.expect("the group sheet draws a dialog inside the box the float sized");
	assert_eq!(
		(dialog.width(), dialog.height()),
		(f32::from(drawn.size.width), f32::from(drawn.size.height)),
		"the dialog takes the box the float sized, so the sheet has one measure and not two"
	);
}

#[test]
fn the_group_sheet_sidebar_is_the_width_its_token_authors() {
	let shipped = load_bundled_tokens().expect("the bundled tokens load");
	let authored = shipped.surface.settings.sidebar_width_px;
	let frame = render(shipped.clone(), group());
	let drawn = sheet(&frame, WINDOW_W as f32);
	let sidebar = sidebar_box(&frame, drawn);
	assert_eq!(sidebar.width(), authored, "the sidebar draws the width its token states");

	let mut other = shipped;
	other.surface.settings.sidebar_width_px = OTHER_SIDEBAR_W;
	let moved_frame = render(other, group());
	let moved_sheet = sheet(&moved_frame, WINDOW_W as f32);
	let moved = sidebar_box(&moved_frame, moved_sheet);
	assert_eq!(
		moved.width(),
		OTHER_SIDEBAR_W,
		"editing the token file resizes the sidebar, so its width is not compiled in"
	);
}
