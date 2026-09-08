//! WHY: §6.5 states that a settings row is exactly the height §5.9 declares
//! and clips what does not fit, and a row holds a control column as well as
//! its prose. A row built with `min_h` grew to whatever it held: a control
//! taller than the band pushed every row under it down the page, and a row
//! that clipped nothing painted its control over the row below.
//!
//! CLASS CLOSED: the row's own band, measured against a control that asks for
//! more room than the row declares. The two frames differ only in how tall
//! that control is, so a row whose height depends on its contents moves the
//! text of the row under it, and a row that paints outside its band changes a
//! pixel below it. Both are asserted, so removing the fixed height and
//! removing the clip each fail.
//!
//! NOT CAUGHT: which part of an oversized control survives the clip, and
//! whether a control that large should be offered at all. The row's prose is
//! measured in
//! `a-settings-row-is-the-height-it-declares-whatever-it-says`, which sweeps
//! every settings page.

use std::path::Path;

use veyyon_desktop_kit::{ColorRole, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	InstalledTokens, controls::Availability, install_tokens, settings::setting_row,
};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

/// The declared row height (§5.9), which the bundled settings tokens author.
const ROW_HEIGHT_PX: f32 = 44.0;
/// A control far taller than the band, which is what a field that asks for its
/// content's height does when the content is long.
const TALL_CONTROL_PX: f32 = 200.0;
const ROWS_WIDTH: f32 = 720.0;
const ROWS_HEIGHT: f32 = 320.0;

/// Two settings rows drawn at the window origin, the first holding a control
/// of `control_height` in an accent fill: the row is asked for more room than
/// it declares, and the fill is the ink a leak would put over the row under it.
struct RowsUnderTest {
	installed:      InstalledTokens,
	control_height: f32,
}

impl Render for RowsUnderTest {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = self.installed.set.clone();
		let geometry = self.installed.surface.settings.clone();
		let control = div()
			.w(px(96.0))
			.h(px(self.control_height))
			.bg(tokens.color(ColorRole::Accent));
		div()
			.w(px(ROWS_WIDTH))
			.flex()
			.flex_col()
			.child(setting_row(
				"First",
				Some("What the first row is for"),
				control,
				&Availability::Enabled,
				&geometry,
				&tokens,
			))
			.child(setting_row(
				"Second",
				Some("What the second row is for"),
				div(),
				&Availability::Enabled,
				&geometry,
				&tokens,
			))
	}
}

/// The pair of rows rendered with a control of `control_height`.
fn rows(control_height: f32) -> Captured {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut cx = headless_context().expect("a headless renderer is required to draw the rows");
	let options = RenderOptions {
		width:        ROWS_WIDTH as u32,
		height:       ROWS_HEIGHT as u32,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	render_view_captured(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| RowsUnderTest { installed, control_height })
	})
	.expect("the rows render offscreen")
}

/// Every text run the frame drew, ordered top down as `(top, bottom)`.
fn run_bands(captured: &Captured) -> Vec<(f32, f32)> {
	let mut bands: Vec<(f32, f32)> = captured
		.text_runs
		.iter()
		.map(|run| (f32::from(run.bounds.top()), f32::from(run.bounds.bottom())))
		.collect();
	bands.sort_by(|left, right| {
		left
			.0
			.partial_cmp(&right.0)
			.expect("a top is a real number")
	});
	bands
}

#[test]
fn a_row_keeps_its_band_whatever_its_control_asks_for() {
	let fitting = rows(24.0);
	let overflowing = rows(TALL_CONTROL_PX);

	let fitting_bands = run_bands(&fitting);
	let overflowing_bands = run_bands(&overflowing);
	assert_eq!(
		fitting_bands.len(),
		4,
		"two rows of a label and a description drew {} lines of text: {fitting_bands:?}",
		fitting_bands.len()
	);
	assert_eq!(
		fitting_bands, overflowing_bands,
		"a control {TALL_CONTROL_PX}px tall moved the text the rows draw, so the row grew to what \
		 it holds instead of clipping it"
	);
	let last = fitting_bands
		.last()
		.expect("the rows drew text")
		.1;
	assert!(
		last <= ROW_HEIGHT_PX * 2.0 + 0.5,
		"the second row's text ends at {last:.1}px, past the {:.1}px two declared rows occupy",
		ROW_HEIGHT_PX * 2.0
	);

	// The fill is drawn inside the first row's band and nowhere else: a row
	// that does not clip paints its control over the row under it, which is
	// how a 240px control column came to cover the next three settings.
	let mut leaked = 0;
	for y in (ROW_HEIGHT_PX as u32)..(ROWS_HEIGHT as u32) {
		for x in 0..(ROWS_WIDTH as u32) {
			if fitting.frame.pixel(x, y) != overflowing.frame.pixel(x, y) {
				leaked += 1;
			}
		}
	}
	assert_eq!(
		leaked, 0,
		"{leaked} pixels below the first row differ between a fitting control and one \
		 {TALL_CONTROL_PX}px tall, so the row painted its control outside its own band"
	);
}
