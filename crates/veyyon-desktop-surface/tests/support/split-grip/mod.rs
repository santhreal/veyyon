//! Reading a splitter grip out of a rendered frame: the shell's two splits,
//! the token that authors their hit area, and the pixels their hairline draws.
//!
//! The drawer split and the panel split are the same kit primitive on two
//! axes, so the suites that drive them open the same shell and read the same
//! bands out of it: the hit rects that end at an edge, and the rows of a 1px
//! line found by its colour rather than by arithmetic on where it ought to be.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

use std::path::Path;

use veyyon_desktop_kit::{ColorRole, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	Captured, Headless, HeadlessSession, RgbaColor, RgbaFrame, headless::RenderOptions,
};
use veyyon_desktop_surface::{
	ShellView,
	damage::Region,
	fixture, install_tokens,
	layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, px};

/// A window wide enough that the queue rail, the transcript and the docked
/// panel all draw, so both splits are in the same frame.
pub const WIDTH: f32 = 1440.0;
pub const HEIGHT: f32 = 900.0;

/// A window at the collapsed row, where the drawer overlays the column's
/// lower edge instead of docking into a split.
pub const NARROW: f32 = 800.0;
pub const SHORT: f32 = 600.0;

/// The travel each drag case moves the edge it took.
pub const TRAVEL: f32 = 56.0;

fn options(width: f32, height: f32) -> RenderOptions {
	RenderOptions {
		width: width as u32,
		height: height as u32,
		scale_factor: 1.0,
		..RenderOptions::default()
	}
}

/// The hit area the panels tokens author for a resize grip.
pub fn authored_grip() -> f32 {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
		.panels
		.chrome_resize_handle_hit_px
}

/// The height the panels tokens author for a chrome row, which is the band the
/// drawer's tab strip draws in.
pub fn authored_chrome_row() -> f32 {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
		.panels
		.chrome_row_height_px
}

/// The colour the theme resolves for a role, as the frame's bytes.
pub fn role_bytes(role: ColorRole) -> RgbaColor {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let set = TokenSet::from_tokens(&tokens, &theme).expect("the bundled token set resolves");
	let rgba = set.color(role).to_rgb();
	let byte = |channel: f32| (channel * 255.0).round().clamp(0.0, 255.0) as u8;
	RgbaColor::new(byte(rgba.r), byte(rgba.g), byte(rgba.b), byte(rgba.a))
}

/// The width the shed docks the panel at in this window, which is where its
/// grip is.
pub fn docked_panel_width() -> f32 {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let shed = ShedInput {
		viewport_px:        WIDTH,
		viewport_height_px: HEIGHT,
		chrome_height_px:   tokens.surface.shell.titlebar_height_px,
		gutter_px:          8.0,
		queue_collapsed:    false,
		queue_float_open:   false,
		panel_open:         true,
		panel_width:        None,
		labels:             LabelState::default(),
	};
	match shell_widths(shed, &tokens.surface).right_panel {
		RightPanelPlacement::Inline { width_px } => width_px,
		other => panic!("a {WIDTH}px window docks the panel; the shed placed it {other:?}"),
	}
}

/// Opens the shell with the drawer already open, so both splits are drawn.
pub fn open(cx: &mut Headless, width: f32, height: f32) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut session =
		HeadlessSession::open(cx, &options(width, height), move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, fixture::with_drawer()))
		})
		.expect("the session opens");
	session.frame().expect("the first frame renders");
	session
}

/// The box the last frame drew a region in, with the raster margin its damage
/// record carries taken back off, which is where a press has to land.
pub fn region_box(session: &mut HeadlessSession<'_, ShellView>, region: Region) -> Bounds<Pixels> {
	session
		.update(move |view, _window, _cx| view.laid_out().drawn_bounds(region))
		.expect("the view is live")
		.unwrap_or_else(|| panic!("the frame recorded no box for {region:?}"))
}

/// Every hit rect whose keyed edge lands within 24px of `edge`, projected by
/// `at` into (keyed edge, span, cross) so a failure states what the frame put
/// beside the split instead of only that the band is missing.
pub fn near(
	captured: &Captured,
	edge: f32,
	at: impl Fn(&Bounds<Pixels>) -> (f32, f32, f32),
) -> Vec<(f32, f32, f32)> {
	captured
		.hitboxes
		.iter()
		.map(at)
		.filter(|(keyed, ..)| (keyed - edge).abs() <= 24.0)
		.collect()
}

/// How far one pixel is from a wanted colour, summed over the channels.
pub fn off_by(found: RgbaColor, wanted: RgbaColor) -> u32 {
	u32::from(found.r.abs_diff(wanted.r))
		+ u32::from(found.g.abs_diff(wanted.g))
		+ u32::from(found.b.abs_diff(wanted.b))
}

/// The pixel at one device row and one logical column.
pub fn pixel_at(frame: &RgbaFrame, x: f32, row: u32) -> RgbaColor {
	let column = frame
		.device_x(x)
		.unwrap_or_else(|| panic!("the frame has no device column for {x}px"));
	frame
		.pixel(column, row)
		.unwrap_or_else(|| panic!("the frame has no pixel at {column},{row}"))
}

/// The device rows the logical band `(start, end)` covers.
const fn rows_of(band: (f32, f32)) -> std::ops::RangeInclusive<u32> {
	band.0.round().max(0.0) as u32..=band.1.round().max(0.0) as u32
}

/// The row inside `band` at `x` whose pixel is nearest `wanted`, and how far
/// off it is, so a 1px line is found by its colour rather than by arithmetic
/// on where it ought to be.
pub fn nearest_row(frame: &RgbaFrame, x: f32, band: (f32, f32), wanted: RgbaColor) -> (u32, u32) {
	rows_of(band)
		.map(|row| (row, off_by(pixel_at(frame, x, row), wanted)))
		.min_by_key(|(_, off)| *off)
		.unwrap_or_else(|| panic!("the frame has no rows in the {band:?} band at {x}px"))
}

/// The rows of `band` at `x` whose pixel is within `tolerance` of `wanted`.
pub fn rows_matching(
	frame: &RgbaFrame,
	x: f32,
	band: (f32, f32),
	wanted: RgbaColor,
	tolerance: u32,
) -> Vec<u32> {
	rows_of(band)
		.filter(|row| off_by(pixel_at(frame, x, *row), wanted) <= tolerance)
		.collect()
}

/// The horizontal runs of a box drawn within `tolerance` of `wanted`, at least
/// `least` pixels long, as (row, first column, length).
///
/// A mark painted inside a row is counted rather than aimed at: a decoration
/// centred in whatever a strip and a control row leave of a row is at neither
/// the row's own middle nor any column a test could name. The run is what
/// separates it from text: a glyph antialiased over the ground passes through
/// every level between, so a row of prose carries isolated pixels of any
/// colour named, and only a drawn mark carries several of them in a row.
pub fn runs_in(
	frame: &RgbaFrame,
	columns: (f32, f32),
	band: (f32, f32),
	wanted: RgbaColor,
	tolerance: u32,
	least: u32,
) -> Vec<(u32, u32, u32)> {
	let first = columns.0.round().max(0.0) as u32;
	let last = columns.1.round().max(0.0) as u32;
	let mut found = Vec::new();
	for row in rows_of(band) {
		let mut run = 0u32;
		for column in first..last {
			if off_by(pixel_at(frame, column as f32, row), wanted) <= tolerance {
				run += 1;
				continue;
			}
			if run >= least {
				found.push((row, column - run, run));
			}
			run = 0;
		}
		if run >= least {
			found.push((row, last - run, run));
		}
	}
	found
}

/// The middle of a box's width, which is where a full-width band is sampled.
pub fn mid_x(bounds: Bounds<Pixels>) -> f32 {
	f32::from(bounds.origin.x) + f32::from(bounds.size.width) / 2.0
}

/// The band of the `grip` pixels immediately above `top`, plus a row either
/// side, which is where an edge above a surface is drawn.
pub fn band_above(top: f32, grip: f32) -> (f32, f32) {
	(top - grip - 1.0, top + 1.0)
}

/// A point inside the grip above `top`, at `x`.
pub fn in_grip(x: f32, top: f32, grip: f32) -> veyyon_gpui::Point<Pixels> {
	veyyon_gpui::Point::new(px(x), px(top - grip / 2.0))
}
