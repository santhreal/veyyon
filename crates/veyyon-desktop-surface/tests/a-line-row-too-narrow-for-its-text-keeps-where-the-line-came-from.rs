//! WHY: a line row (§5.2, §8.25) sets its detail beside its title, and the
//! primitive gave the title a box that never shrank. A title wider than the
//! line therefore ran under the row's edge, was cut mid-glyph with no ellipsis,
//! and squeezed the detail — which for a content-search hit is the `path:line`
//! naming where the line came from — out of the row entirely. Every long match
//! in `/search` listed the matched text and nothing about which file held it.
//!
//! CLASS CLOSED:
//! 1. Any line row whose title and detail together are wider than the row: the
//!    detail is asserted to still draw a run of its own, in every mode a
//!    `PaletteState` constructor produces plus the lookup modes, with each
//!    title forced past the row's width.
//! 2. Text escaping the row horizontally, in either direction, which the
//!    sibling band suite deliberately does not test.
//! 3. The opposite squeeze: a detail long enough to starve the title, so the
//!    cap on the detail's share of the line is load-bearing rather than
//!    decorative.
//! 4. A new lookup mode listing rows with detail, since the states are built
//!    from the constructors rather than from a fixture of rows.
//!
//! NOT CAUGHT: which characters survive truncation, and whether the ellipsis
//! glyph is the one the font offers — a captured run carries its box and its
//! size, not its text. The strings a row states are asserted in
//! `a-palette-row-draws-the-mark-it-carries.rs`, and the shape is photographed
//! by `proof/scenes/desktop-content-search.sh`.

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless::{Captured, headless_context};
use veyyon_desktop_surface::{
	Intent, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, Row, Section,
};
use veyyon_desktop_tokens::SpacingStep;
use veyyon_gpui::{Bounds, Pixels};

#[path = "support/palette-rows/mod.rs"]
mod palette_rows;

use palette_rows::{captured_over_nothing, model_control};

/// The palette's result row height and the inset its text is drawn inside.
fn row_height_and_inset() -> (f32, f32) {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	(bundled.surface.palette.results_row_height_px, bundled.scale.spacing(SpacingStep::S3))
}

/// The result rows of the open palette, taken from the hit rects the frame
/// registered, so these are rows the operator can act on rather than a fixture.
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

/// The runs drawn on the row's line, left to right: a run belongs to the row
/// when its vertical centre is inside the row and it starts at or after the
/// row's left edge, since the shell paints the session under the overlay.
fn runs_on(captured: &Captured, row: Bounds<Pixels>) -> Vec<(f32, f32)> {
	let top = f32::from(row.origin.y);
	let bottom = top + f32::from(row.size.height);
	let left = f32::from(row.origin.x);
	let right = left + f32::from(row.size.width);
	let mut runs: Vec<(f32, f32)> = captured
		.text_runs
		.iter()
		.filter(|run| {
			let centre = f32::midpoint(f32::from(run.bounds.top()), f32::from(run.bounds.bottom()));
			centre > top && centre < bottom
		})
		.filter(|run| {
			let start = f32::from(run.bounds.left());
			start >= left - 0.5 && start <= right
		})
		.map(|run| (f32::from(run.bounds.left()), f32::from(run.bounds.right())))
		.collect();
	runs.sort_by(|left, right| {
		left
			.0
			.partial_cmp(&right.0)
			.expect("a run origin is a real number")
	});
	runs
}

fn session_rows() -> Vec<(Section, Vec<Row>)> {
	vec![(Section::Live, vec![Row {
		id:       7,
		title:    "port the loader".into(),
		subtitle: "ws-default".into(),
		badge:    None,
		meta:     None,
	}])]
}

/// One row of a lookup: the shape `/files` and `/search` list, whose detail is
/// the only statement of where the row's text came from.
fn lookup(mode: PaletteMode, title: &str, subtitle: &str) -> PaletteState {
	let mut state = PaletteState::new(mode);
	state.set_items(vec![PaletteItem {
		id:         1,
		title:      title.to_string(),
		subtitle:   Some(subtitle.to_string()),
		group:      None,
		search:     None,
		badge:      None,
		meta:       None,
		capability: None,
		kind:       PaletteItemKind::Command { intent: Box::new(Intent::NewSession) },
	}]);
	state
}

/// Every state a producer builds, plus the two lookups, named for its mode.
fn every_producer() -> Vec<(&'static str, PaletteState)> {
	vec![
		("commands", PaletteState::commands()),
		("sessions", PaletteState::from_sessions(&session_rows())),
		("models", PaletteState::from_models(&model_control())),
		("files", lookup(PaletteMode::Files, "loader.ts", "src/host/loader.ts")),
		(
			"content-search",
			lookup(
				PaletteMode::ContentSearch,
				"export const poolSize = Number(process.env.POOL_SIZE ?? \"8\");",
				"service/store/pool.ts:2",
			),
		),
	]
}

/// The same rows with every title forced past the row's width, so each mode is
/// swept in the state where the title and its detail cannot both fit.
fn overlong_titles(state: &PaletteState) -> PaletteState {
	let mut widened = state.clone();
	let mut items = state.items().to_vec();
	for item in &mut items {
		item.title = format!("{} {}", item.title, "a-word-nobody-would-type".repeat(6));
		if item.subtitle.is_none() {
			item.subtitle = Some("service/store/pool.ts:2".to_string());
		}
	}
	widened.set_items(items);
	widened
}

#[test]
fn a_title_wider_than_its_row_yields_rather_than_dropping_the_detail() {
	let (row_height, inset) = row_height_and_inset();
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");

	for (name, state) in every_producer() {
		let widened = overlong_titles(&state);
		let expected = widened.items().len();
		let frame = captured_over_nothing(&mut cx, widened);
		let rows = result_rows(&frame, row_height);
		assert!(!rows.is_empty(), "{name}: the palette drew no result row, so this proves nothing");
		assert!(rows.len() <= expected.max(rows.len()), "{name}: more rows than items were listed");

		for (index, row) in rows.iter().enumerate() {
			let runs = runs_on(&frame, *row);
			assert!(
				runs.len() >= 2,
				"{name} row {index}: {} run(s) on the line — the title took the whole row and the \
				 detail naming where it came from was squeezed out",
				runs.len()
			);
			let limit = f32::from(row.origin.x) + f32::from(row.size.width) - inset + 0.5;
			for (start, end) in &runs {
				assert!(
					*end <= limit,
					"{name} row {index}: a run ends at {end} past the row's {limit} inner edge, so it \
					 was cut by the row instead of truncating itself"
				);
				assert!(
					*start >= f32::from(row.origin.x) - 0.5,
					"{name} row {index}: a run starts at {start}, left of the row"
				);
			}
		}
	}
}

#[test]
fn a_detail_long_enough_to_starve_the_title_is_capped_instead() {
	let (row_height, _) = row_height_and_inset();
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");

	let state = lookup(
		PaletteMode::ContentSearch,
		"poolSize",
		&format!("{}/pool.ts:2", "service/a-directory-nobody-would-name".repeat(6)),
	);
	let frame = captured_over_nothing(&mut cx, state);
	let rows = result_rows(&frame, row_height);
	let row = *rows.first().expect("the lookup drew its one row");
	let runs = runs_on(&frame, row);
	assert!(
		runs.len() >= 2,
		"a detail wider than the line took the whole row: {} run(s) drawn, so the title it belongs \
		 to states nothing",
		runs.len()
	);
	let title = runs.first().expect("the leading run is the title");
	let half = f32::from(row.size.width) / 2.0;
	assert!(
		title.1 - title.0 < half,
		"the title measures {}px of a {}px row, so it is not the short title this arm sets",
		title.1 - title.0,
		f32::from(row.size.width)
	);
	let detail = runs.last().expect("the trailing run is the detail");
	assert!(
		detail.1 - detail.0 <= half + 0.5,
		"the detail measures {}px, more than the {half}px half of the line it is capped at",
		detail.1 - detail.0
	);
}
