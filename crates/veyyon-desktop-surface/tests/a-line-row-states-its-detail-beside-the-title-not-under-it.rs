//! WHY: the line row (§5.2) is 8 + a 20px title band + 8, and every palette
//! result, session search hit and process row is drawn with it. The list row
//! primitive stacked a row's detail *under* its title in a column, so a row
//! given the fixed 36px height held two stacked text bands — 20px of title plus
//! 16px of detail — in a box with no room for the second. The command palette
//! drew every description touching the next command's name, and a reader could
//! not tell which subtitle belonged to which row.
//!
//! CLASS CLOSED:
//! 1. Any fixed-height list row that draws its text on more than one line.
//!    Every result row the palette draws is swept from the frame's own hit
//!    rects, and the runs inside one row are merged by overlap, so a second
//!    line fails whether or not it stays inside the row.
//! 2. A line of text taller than the band the row height authors: 36px less the
//!    row's 8px insets, read from the tokens rather than written here.
//! 3. Text drawn outside the row that holds it, in either direction.
//! 4. Closing the row by dropping the detail: the same producers are captured
//!    with their subtitles removed, and the frame is asserted to lose runs.
//! 5. Every producer of palette rows, taken from `PaletteState`'s own
//!    constructors, so a new mode listing rows with detail is swept here, plus
//!    a row whose title alone is wider than the palette.
//!
//! NOT CAUGHT: which text a row states, and the order of the title and its
//! detail on the line. Those are judged from `proof/scenes/desktop-palette.sh`
//! and asserted as strings in `a-palette-row-draws-the-mark-it-carries.rs`; a
//! captured run carries its box and its size, not its characters. The padded
//! two-line shape the primitive still offers is asserted in
//! `veyyon-desktop-kit/tests/
//! a-row-given-a-height-sets-its-detail-on-the-line-not-under-it.rs`.
//! A run drawn behind the palette that starts inside a row's box would be
//! counted as the row's; the session under the overlay is emptied so none is.

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless::{Captured, headless_context};
use veyyon_desktop_surface::{
	Badge, Intent, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, Row, Section,
};
use veyyon_desktop_tokens::SpacingStep;
use veyyon_gpui::{Bounds, Pixels};

#[path = "support/palette-rows/mod.rs"]
mod palette_rows;

use palette_rows::{captured_over_nothing, model_control, text_run_count};

/// The palette's result row height, and the one text band it is built from:
/// 8 above, the band, 8 below (§5.2).
fn row_and_band() -> (f32, f32) {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	let row = bundled.surface.palette.results_row_height_px;
	(row, row - 2.0 * bundled.scale.spacing(SpacingStep::S4))
}

/// The result rows of the open palette, taken from the hit rects the frame
/// registered: a row is hit-tested because it answers a click, so this is the
/// set of rows the operator can act on rather than a fixture of them.
///
/// The palette is the only surface drawing a row of the palette's row height at
/// the palette's width, so the width filter separates its rows from the rail's
/// line rows and the drawer's process rows.
fn result_rows(captured: &Captured, row_height: f32) -> Vec<Bounds<Pixels>> {
	let mut rows: Vec<Bounds<Pixels>> = captured
		.hitboxes
		.iter()
		.filter(|hit| (f32::from(hit.size.height) - row_height).abs() <= 0.5)
		.filter(|hit| f32::from(hit.size.width) > 400.0)
		.copied()
		.collect();
	rows.sort_by(|left, right| {
		f32::from(left.origin.y)
			.partial_cmp(&f32::from(right.origin.y))
			.expect("a row origin is a real number")
	});
	rows
}

/// The text bands the row drew: the vertical spans of its runs, merged where
/// they overlap and ordered top down, so one band is one line of text. A run
/// counts as the row's when it starts inside the row's box, since the shell
/// paints the session under the overlay and a run behind a palette row shares
/// its band on a captured frame. A run that starts inside and is clipped at the
/// row's edge — the row whose title is wider than the palette — is the row's,
/// which is why the right edge is not tested.
fn bands_in(captured: &Captured, row: Bounds<Pixels>) -> Vec<(f32, f32)> {
	let top = f32::from(row.origin.y);
	let bottom = top + f32::from(row.size.height);
	let left = f32::from(row.origin.x);
	let right = left + f32::from(row.size.width);
	let mut spans: Vec<(f32, f32)> = captured
		.text_runs
		.iter()
		.filter(|run| {
			let left_edge = f32::from(run.bounds.left());
			left_edge >= left - 0.5 && left_edge <= right
		})
		.map(|run| (f32::from(run.bounds.top()), f32::from(run.bounds.bottom())))
		.filter(|(run_top, run_bottom)| {
			let centre = (run_top + run_bottom) / 2.0;
			centre > top && centre < bottom
		})
		.collect();
	spans.sort_by(|left, right| {
		left
			.0
			.partial_cmp(&right.0)
			.expect("a top is a real number")
	});

	let mut merged: Vec<(f32, f32)> = Vec::new();
	for (span_top, span_bottom) in spans {
		match merged.last_mut() {
			Some(held) if span_top < held.1 => held.1 = held.1.max(span_bottom),
			_ => merged.push((span_top, span_bottom)),
		}
	}
	merged
}

fn session_rows() -> Vec<(Section, Vec<Row>)> {
	vec![(Section::Live, vec![
		Row {
			id:       7,
			title:    "port the loader".into(),
			subtitle: "ws-default".into(),
			badge:    Some(Badge::Working),
			meta:     None,
		},
		Row {
			id:       8,
			title:    "rewrite the walker cache".into(),
			subtitle: "veyyon · feat/gui".into(),
			badge:    None,
			meta:     None,
		},
	])]
}

/// A row whose title alone is wider than the palette, so the row that has to
/// truncate is drawn as well as the rows that fit.
fn overlong() -> PaletteState {
	let mut state = PaletteState::new(PaletteMode::Commands);
	state.items = vec![PaletteItem {
		id:       1,
		title:    "/".to_string() + &"a-command-with-a-name-nobody-would-type".repeat(4),
		subtitle: Some("a description at least as long as the name above it".repeat(3)),
		group:    None,
		search:   None,
		badge:    None,
		meta:     None,
		kind:     PaletteItemKind::Command { intent: Box::new(Intent::NewSession) },
	}];
	state
}

/// Every palette state a producer builds, named for the mode it opens in. Taken
/// from `PaletteState`'s constructors rather than hand-built rows, so a mode
/// that starts listing detail is swept without editing this suite.
fn every_producer() -> Vec<(&'static str, PaletteState)> {
	vec![
		("commands", PaletteState::commands()),
		("sessions", PaletteState::from_sessions(&session_rows())),
		("models", PaletteState::from_models(&model_control())),
		("overlong", overlong()),
	]
}

/// The same rows with the detail taken off: the control arm proving the detail
/// is drawn at all, so a row that fits its band by dropping it fails.
fn without_detail(state: &PaletteState) -> PaletteState {
	let mut stripped = state.clone();
	for item in &mut stripped.items {
		item.subtitle = None;
	}
	stripped
}

#[test]
fn every_result_row_keeps_its_text_in_the_band_the_row_height_authors() {
	let (row_height, band) = row_and_band();
	assert!(
		band < row_height,
		"a {band}px band in a {row_height}px row leaves no inset, so this suite measures nothing"
	);
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");

	for (name, state) in every_producer() {
		let detailed = state
			.items
			.iter()
			.filter(|item| item.subtitle.is_some())
			.count();
		assert!(detailed > 0, "{name}: no row here carries detail, so it proves nothing");

		let frame = captured_over_nothing(&mut cx, state);
		let rows = result_rows(&frame, row_height);
		assert!(
			rows.len() >= detailed.min(2),
			"{name}: the frame offers {} result rows for {detailed} rows carrying detail",
			rows.len()
		);

		for row in rows {
			let top = f32::from(row.origin.y);
			let bands = bands_in(&frame, row);
			assert_eq!(
				bands.len(),
				1,
				"{name}: the row at {top}px draws {} lines of text in a {row_height}px row, so its \
				 detail is stacked under its title: {bands:?}",
				bands.len()
			);
			let (band_top, band_bottom) = bands[0];
			assert!(
				band_bottom - band_top <= band + 1.5,
				"{name}: the row at {top}px draws a {:.1}px line of text in the {band}px band its \
				 {row_height}px row authors",
				band_bottom - band_top
			);
			assert!(
				band_top >= top - 0.5 && band_bottom <= top + row_height + 0.5,
				"{name}: the row at {top}px draws text from {band_top:.1}px to {band_bottom:.1}px, \
				 outside its own {row_height}px row"
			);
		}
	}
}

#[test]
fn a_row_that_fits_its_band_still_states_its_detail() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	for (name, state) in every_producer() {
		let with = text_run_count(&captured_over_nothing(&mut cx, state.clone()));
		let without = text_run_count(&captured_over_nothing(&mut cx, without_detail(&state)));
		assert!(
			with > without,
			"{name}: the frame drew the same {with} runs with the detail and without it, so the row \
			 fits its band by dropping what it states"
		);
	}
}
