//! WHY THIS TEST EXISTS:
//! This is milestone M0's gate. The iteration plan replaces serial
//! edit-and-look passes with one image holding every candidate, and that only
//! works if producing the image is cheap enough to sit inside a judgement loop.
//! Twelve renders, twelve metric evaluations and one composite must finish in
//! under five seconds; past that the loop stops being used and surfaces get
//! judged once instead of a dozen times.
//!
//! THE CLASS THIS CLOSES: a sweep that reports success without producing a
//! comparable image. Each candidate must differ from its neighbours, every cell
//! must reach the sheet, the sheet must be larger than any single cell, and the
//! whole pass must stay inside the budget. A tiler that dropped cells, painted
//! them on top of each other, or emitted a uniform image fails.
//!
//! WHAT IT DOES NOT CATCH: whether the candidate a person picks is the right
//! one. The sheet exists so that judgement is made by eye; no assertion here
//! substitutes for it. It also does not assert the caption's text, only that a
//! caption occupies space, because the exact string is not parsed by anything.

use std::time::Instant;

use veyyon_desktop_scene::{
	Appearance, RenderOptions, RgbaColor, SheetCell, SheetGrid, distinct_pixel_values,
	headless_context, render_view_with_layout, tile, write_png,
};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px, rgb,
};

/// The sweep budget from milestone M0.
const BUDGET_SECONDS: f32 = 5.0;
const CANDIDATES: usize = 12;

const GROUND: u32 = 0x14_14_1a;
const CANVAS: u32 = 0x1e_1e_28;
const ACCENT: u32 = 0x7a_a2_f7;
const INK: u32 = 0xc0_ca_f5;

/// A row whose internal gap is the swept parameter. Gap is the metric the plan
/// calls the strongest single predictor of a frame reading as noisy, so it is
/// the parameter a first sweep exists to choose.
struct GapCandidate {
	gap: f32,
}

impl Render for GapCandidate {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let rows: Vec<_> = (0..4)
			.map(|index| {
				div()
					.flex()
					.flex_row()
					.gap(px(self.gap))
					.child(
						div()
							.w(px(18.0))
							.h(px(18.0))
							.bg(rgb(ACCENT))
							.rounded(px(4.0)),
					)
					.child(
						div()
							.text_size(px(12.0))
							.text_color(rgb(INK))
							.child(format!("session {index}")),
					)
			})
			.collect();

		div().size_full().bg(rgb(GROUND)).p(px(12.0)).child(
			div()
				.size_full()
				.bg(rgb(CANVAS))
				.rounded(px(8.0))
				.p(px(10.0))
				.flex()
				.flex_col()
				.gap(px(self.gap))
				.children(rows),
		)
	}
}

/// Candidate gap values, indexed by integer step so the sequence is exact and
/// does not drift the way an accumulated float delta would.
const fn candidate_gap(step: usize) -> f32 {
	// 2px through 24px in 2px steps: the spacing scale's lower half, which is
	// where a row's gap is actually chosen.
	2.0_f32.mul_add(step as f32, 2.0)
}

#[test]
fn twelve_gap_candidates_render_and_tile_within_the_budget() {
	let started = Instant::now();

	let mut cx = headless_context().expect("a headless renderer is required");
	let options = RenderOptions {
		width:        280,
		height:       160,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let mut cells = Vec::with_capacity(CANDIDATES);
	for step in 0..CANDIDATES {
		let gap = candidate_gap(step);
		let (frame, tree) =
			render_view_with_layout(&mut cx, &options, move |_window, app: &mut App| {
				app.new(move |_| GapCandidate { gap })
			})
			.expect("a candidate rasterises");

		assert!(
			distinct_pixel_values(&frame) > 1,
			"candidate at gap {gap} rendered a uniform frame, so nothing was drawn",
		);
		let cell = SheetCell::from_rendered(
			format!("queue-row  gap {gap:.0}"),
			frame,
			&tree,
			RgbaColor::new(0x14, 0x14, 0x1a, 255),
		);
		assert!(cell.metrics.is_some(), "candidate at gap {gap} must carry computed clutter metrics");
		cells.push(cell);
	}

	assert_eq!(cells.len(), CANDIDATES, "every candidate produced a cell");

	// Neighbouring candidates must differ, or the swept parameter never reached
	// the render and the sheet would show twelve copies of one frame.
	for step in 1..CANDIDATES {
		let (previous, current) = (&cells[step - 1], &cells[step]);
		assert_ne!(
			previous.frame.as_bytes(),
			current.frame.as_bytes(),
			"candidates {} and {step} rendered identical bytes, so the gap did not reach the render",
			step - 1,
		);
	}

	let cell_width = cells[0].frame.width();
	let cell_height = cells[0].frame.height();

	let grid = SheetGrid::new(4);
	assert_eq!(grid.rows_for(CANDIDATES as u32), 3, "twelve cells in four columns is a 4x3 grid");

	let sheet = tile(&mut cx, cells, grid, 2.0).expect("the sheet composites");

	// The sheet holds four columns and three rows, so it must exceed one cell in
	// both directions. A tiler that painted every cell at the origin would
	// produce a sheet the size of one cell.
	assert!(
		sheet.width() > cell_width * 3,
		"sheet is {} device px wide, which cannot hold four columns of {cell_width}px cells",
		sheet.width(),
	);
	assert!(
		sheet.height() > cell_height * 2,
		"sheet is {} device px tall, which cannot hold three rows of {cell_height}px cells",
		sheet.height(),
	);
	assert!(
		distinct_pixel_values(&sheet) > 1,
		"the sheet is a uniform image, so no cell reached it",
	);

	let elapsed = started.elapsed().as_secs_f32();

	let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../target/scene-frames/sweep-queue-row-gap.png");
	write_png(&sheet, &path).expect("the sheet encodes as a PNG");

	assert!(
		elapsed < BUDGET_SECONDS,
		"the twelve-candidate sweep took {elapsed:.2}s, over the {BUDGET_SECONDS:.1}s budget; past \
		 the budget the loop stops being used and surfaces get judged once",
	);

	println!("sweep of {CANDIDATES} candidates in {elapsed:.2}s -> {}", path.display());
}

#[test]
fn a_sheet_with_no_cells_is_reported_rather_than_rendered_empty() {
	// An empty sheet has no size. Returning a zero-sized or uniform image here
	// would read as "the sweep found no differences" rather than "the sweep was
	// given nothing".
	let mut cx = headless_context().expect("a headless renderer is required");
	let outcome = tile(&mut cx, Vec::new(), SheetGrid::new(4), 2.0);
	assert!(outcome.is_err(), "an empty cell list produced a sheet");
}
