//! WHY: `ListRow` stacked a title over its detail in a column whatever height
//! it was given. A surface that fixes the row to the line shape (§5.2) — the
//! palette's results, the drawer's process rows — then held two stacked text
//! bands in a box sized for one, so the detail of one row was drawn touching
//! the title of the next.
//!
//! THE CLASS THIS CLOSES: the primitive placing a row's detail somewhere the
//! row's own height has no room for, in either direction. Both shapes are
//! asserted from one frame: a row given a fixed height draws its title and its
//! detail on one band inside that height, and a row left with its padding still
//! stacks them on two bands and grows to hold both. A fix that drops the detail
//! from the line shape, or that flattens the padded shape into a line, fails.
//! A long title and a long detail are drawn as well, since that is the row that
//! has to give up width rather than height.
//!
//! WHAT IT DOES NOT CATCH: which text a row states, and whether a surface gave
//! the row the right height for the shape it wanted. The palette's own rows are
//! measured against their authored token in
//! `veyyon-desktop-surface/tests/
//! a-line-row-states-its-detail-beside-the-title-not-under-it.rs`.

mod common;

use common::headless_context;
use veyyon_desktop_kit::{ListRow, TokenSet};
use veyyon_gpui::{
	AppContext, Context, IntoElement, ParentElement, Pixels, Render, Styled, Window, div, px, size,
};

const ROW_HEIGHT: f32 = 36.0;
const LONG_TITLE: &str = "a command with a name nobody would ever type into the palette at all";
const LONG_DETAIL: &str = "a description at least as long as the name above it, and then some";

/// One row, drawn at the window origin with nothing above it, so a band
/// measured on the frame is the row's own and not an offset the harness added.
struct RowUnderTest {
	fixed:  bool,
	long:   bool,
	detail: bool,
}

impl Render for RowUnderTest {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let title = if self.long { LONG_TITLE } else { "/new" };
		let mut row = ListRow::new(title).id("row-under-test");
		if self.detail {
			row = row.subtitle(if self.long {
				LONG_DETAIL
			} else {
				"Create a new session"
			});
		}
		if self.fixed {
			row = row.height(px(ROW_HEIGHT));
		}
		div().w(px(320.0)).child(row)
	}
}

/// What one render of the row says: the vertical bands of text it drew, merged
/// where runs overlap and ordered top down so one band is one line, and how
/// many shaped runs the frame registered.
fn drawn(fixed: bool, long: bool, detail: bool) -> (Vec<(f32, f32)>, usize) {
	let (mut cx, _permit) = headless_context();
	let window = cx
		.open_window(size(px(320.0), px(240.0)), |_window, app| {
			app.set_global(TokenSet::default());
			app.new(|_cx| RowUnderTest { fixed, long, detail })
		})
		.expect("a headless window opens");
	let frame = cx
		.update_window(window.into(), |_, window, _| window.render_to_frame(1.0))
		.expect("the window renders")
		.expect("the frame is captured");

	let runs = frame.text_runs();
	let mut spans: Vec<(f32, f32)> = runs
		.iter()
		.map(|run| (f32::from(run.bounds.top()), f32::from(run.bounds.bottom())))
		.collect();
	spans.sort_by(|left, right| {
		left
			.0
			.partial_cmp(&right.0)
			.expect("a top is a real number")
	});

	let mut merged: Vec<(f32, f32)> = Vec::new();
	for (top, bottom) in spans {
		match merged.last_mut() {
			Some(held) if top < held.1 => held.1 = held.1.max(bottom),
			_ => merged.push((top, bottom)),
		}
	}
	(merged, runs.len())
}

fn bands(fixed: bool, long: bool, detail: bool) -> Vec<(f32, f32)> {
	drawn(fixed, long, detail).0
}

fn height_of(bands: &[(f32, f32)]) -> f32 {
	let top = bands.first().expect("the row drew text").0;
	let bottom = bands.last().expect("the row drew text").1;
	bottom - top
}

#[test]
fn a_row_given_a_height_draws_one_band_inside_it() {
	for long in [false, true] {
		let with_detail = bands(true, long, true);
		assert_eq!(
			with_detail.len(),
			1,
			"a fixed-height row with a {} detail drew {} bands of text: {with_detail:?}",
			if long { "long" } else { "short" },
			with_detail.len()
		);
		let (top, bottom) = with_detail[0];
		assert!(
			top >= -0.5 && bottom <= ROW_HEIGHT + 0.5,
			"a fixed-height row drew text from {top:.1}px to {bottom:.1}px, outside its \
			 {ROW_HEIGHT}px row"
		);
	}
}

#[test]
fn a_row_given_a_height_still_draws_the_detail_it_holds() {
	// The detail shares the title's band, so it cannot be counted in bands: it
	// is counted in the runs the frame gained by holding it.
	let (bare, without) = drawn(true, false, false);
	let (detailed, with) = drawn(true, false, true);
	assert_eq!(bare.len(), 1, "a row with no detail drew {} bands, not one line", bare.len());
	assert_eq!(detailed.len(), 1, "the detailed row drew {} bands", detailed.len());
	assert!(
		with > without,
		"the frame drew {with} runs with the detail and {without} without it, so a fixed-height row \
		 fits its band by dropping what it states"
	);
}

#[test]
fn a_row_left_with_its_padding_stacks_the_detail_under_the_title() {
	let stacked = bands(false, false, true);
	assert_eq!(
		stacked.len(),
		2,
		"a padded row drew {} bands of text, so the two-line shape the settings and account lists \
		 read as is gone: {stacked:?}",
		stacked.len()
	);
	assert!(
		height_of(&stacked) > height_of(&bands(false, false, false)),
		"a padded row with detail is no taller than one without it, so it does not grow to hold \
		 what it states"
	);
}

#[test]
fn the_two_shapes_are_not_the_same_row() {
	let line: Pixels = px(height_of(&bands(true, false, true)));
	let padded: Pixels = px(height_of(&bands(false, false, true)));
	assert!(
		line < padded,
		"the line shape ({line:?}) draws as tall a stack as the padded shape ({padded:?}), so a \
		 surface fixing the row height gains nothing by it"
	);
}
