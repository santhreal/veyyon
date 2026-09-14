//! WHY: `PaletteState::filtered_items` fuzzy-ranked the whole candidate list on
//! every call, and the palette's render path calls it once per frame. With the
//! model catalogue open (4580 rows, five scored fields each, every candidate
//! string lowercased into a fresh allocation) one frame spent ~12ms in scoring
//! alone, the window's own event loop never caught up, and the surface stopped
//! answering the keyboard: typing in the model picker changed nothing and
//! Enter never reached the selected row.
//!
//! CLASS CLOSED: ranking on a read. The order is now computed by the write
//! paths and held as row indices, so a frame, which holds `&PaletteState`,
//! cannot rank — `rank` is private and every public writer calls it. This
//! suite proves both halves for every mode the palette has, enumerated from
//! `PaletteMode` at run time so a seventh mode is swept without an edit:
//!   1. Every write path leaves rows that answer what it wrote, so a writer
//!      that forgets to rank serves a stale list and is caught here.
//!   2. Reading a frame's rows costs a fraction of one rank, so scoring cannot
//!      return to the render path unnoticed.
//!
//! WHAT THIS DOES NOT CATCH: the cost of one rank, which is paid per keystroke
//! and is not bounded here; how long a frame takes to paint, which llvmpipe
//! dominates on a headless display; and a route filter applied only to the
//! empty query, which is the ranking's existing contract rather than this
//! defect. The ratio in the second test is loose (10x against a measured
//! ~350x) so it fails on a regression, not on a slow machine.

use std::time::Instant;

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{
	Intent, SettingsPage,
	navigation::SurfaceRoute,
	palette::{PaletteItem, PaletteItemKind, PaletteMode, PaletteState, fuzzy_score},
};

/// Rows shaped like a provider catalogue: a name, an id nobody would type in
/// full, and a heading every twentieth row starts. The headings are authored
/// contiguously, so a ranked order that scatters them is the surface's doing.
fn seeded(count: usize) -> Vec<PaletteItem> {
	(0..count)
		.map(|index| {
			let mut item = PaletteItem::command(
				index as u64 + 1,
				format!("Model Number {index}"),
				Intent::NewSession,
				None,
			);
			item.subtitle = Some(format!("model-{index}-claude-sonnet-4-5"));
			item.group = Some(format!("provider-{}", index / 20));
			item
		})
		.collect()
}

/// The strings a row is searchable by, as the ranking scores them. A seeded row
/// carries no navigation intent, so it has no route aliases.
fn fields(item: &PaletteItem) -> Vec<&str> {
	let mut fields = vec![item.title.as_str()];
	fields.extend(item.subtitle.as_deref());
	fields.extend(item.group.as_deref());
	fields.extend(item.search.as_deref());
	fields
}

/// Whether `query` matches any field of `item`.
fn matches(query: &str, item: &PaletteItem) -> bool {
	fields(item)
		.iter()
		.any(|field| fuzzy_score(query, field).is_some())
}

/// Asserts the rows on offer are the rows the query matches and no others, and
/// that rows sharing a heading stay together so a heading is drawn once.
fn assert_rows_answer(state: &PaletteState, query: &str, label: &str) {
	let rows = state.filtered_items();
	for row in &rows {
		assert!(
			matches(query, row),
			"{label}: {:?} is offered for {query:?} and matches none of its fields",
			row.title
		);
	}
	let offered: Vec<&str> = rows.iter().map(|row| row.title.as_str()).collect();
	for item in state.items() {
		if matches(query, item) {
			assert!(
				offered.contains(&item.title.as_str()),
				"{label}: {:?} matches {query:?} and is not offered",
				item.title
			);
		}
	}
	let mut seen: Vec<&str> = Vec::new();
	let mut previous: Option<&str> = None;
	for row in &rows {
		let heading = row.group.as_deref().unwrap_or("");
		if previous != Some(heading) {
			assert!(!seen.contains(&heading), "{label}: heading {heading:?} is drawn twice");
			seen.push(heading);
			previous = Some(heading);
		}
	}
}

/// Every write path ranks what it wrote. A writer that changes the inputs and
/// leaves the previous order behind offers rows that do not answer the query,
/// which is what this asserts against for every mode the palette has.
#[test]
fn every_write_path_leaves_the_rows_ranked_for_what_it_wrote() {
	for mode in PaletteMode::iter() {
		let label = format!("{mode:?}");

		let mut state = PaletteState::new(mode);
		state.set_items(seeded(120));
		assert_eq!(state.filtered_items().len(), 120, "{label}: set_items offers every row");
		assert_rows_answer(&state, "", &format!("{label}/set_items"));

		state.set_query("sonnet4");
		assert!(!state.filtered_items().is_empty(), "{label}: the query matches rows");
		assert_rows_answer(&state, "sonnet4", &format!("{label}/set_query"));

		// A query nothing answers empties the list rather than keeping the
		// previous rows, which is the shape a stale order takes.
		state.set_query("zzqqxx");
		assert!(
			state.filtered_items().is_empty(),
			"{label}: an unmatched query still offers {} rows",
			state.filtered_items().len()
		);

		state.set_query("Number 1");
		let before = state.filtered_items().len();
		state.set_items(seeded(40));
		assert!(
			state.filtered_items().len() < before,
			"{label}: a shorter list still offers {} rows",
			state.filtered_items().len()
		);
		assert_rows_answer(&state, "Number 1", &format!("{label}/set_items after query"));

		state.retain_items(|item| item.id % 2 == 0);
		assert_rows_answer(&state, "Number 1", &format!("{label}/retain_items"));
		for row in state.filtered_items() {
			assert_eq!(row.id % 2, 0, "{label}: a dropped row is still offered");
		}

		// A route change re-ranks: the empty query keeps the commands this
		// route owns and drops the ones another destination owns.
		state.set_query("");
		state.set_items(vec![
			PaletteItem::command(1, "Settings", Intent::Navigate(SurfaceRoute::Settings), None),
			PaletteItem::command(
				2,
				"General",
				Intent::Navigate(SurfaceRoute::Page(SettingsPage::General)),
				None,
			),
		]);
		assert_eq!(state.filtered_items().len(), 2, "{label}: no route owns every command");
		state.set_route(Some(SurfaceRoute::Commands));
		let offered: Vec<&str> = state
			.filtered_items()
			.iter()
			.map(|row| row.title.as_str())
			.collect();
		assert_eq!(offered, ["Settings"], "{label}: the commands route offers its own children");
		state.set_route(None);
		assert_eq!(
			state.filtered_items().len(),
			2,
			"{label}: leaving the route offers the commands it had dropped"
		);

		let mut browse = PaletteState::new(PaletteMode::Browse);
		browse.set_items(seeded(30));
		browse.set_query("Number 2");
		browse.browse_to(Some("crates".to_owned()));
		assert_eq!(browse.query(), "", "browse_to clears the query it listed under");
		assert_eq!(browse.filtered_items().len(), 30, "browse_to ranks the rows it listed");
	}
}

/// A frame reads the ranked order; it does not compute it. The read is measured
/// against one rank over the same rows, so the bound holds whatever the
/// machine's speed and whether the build is optimized.
#[test]
fn a_frame_reads_the_ranked_rows_without_ranking_again() {
	let mut state = PaletteState::new(PaletteMode::Models);
	state.set_items(seeded(4580));

	let ranking = Instant::now();
	state.set_query("sonnet4");
	let rank = ranking.elapsed();
	let rows = state.filtered_items().len();
	assert!(rows > 0, "the catalogue answers the query");

	let rounds = 200usize;
	let reading = Instant::now();
	let mut read = 0usize;
	for _ in 0..rounds {
		read += state.filtered_items().len();
	}
	let reads = reading.elapsed();
	assert_eq!(read, rows * rounds, "every read offers the same rows");
	assert!(
		reads < rank * 10,
		"{rounds} frames read {rows} rows in {reads:?}, against {rank:?} for one rank: the render \
		 path is ranking again"
	);
}

/// The highlighted row is a row of the ranked list, and running it runs that
/// row's own intent rather than whatever held the index before the query.
#[test]
fn the_selected_row_is_the_row_the_ranked_list_shows() {
	let mut state = PaletteState::new(PaletteMode::Models);
	state.set_items(seeded(200));
	state.set_query("Number 137");
	let rows = state.filtered_items();
	assert!(!rows.is_empty(), "the query matches a row");
	let first = rows[0].title.clone();
	assert_eq!(
		state.selected_item().map(|item| item.title.clone()),
		Some(first),
		"the selection is the first ranked row after a query"
	);

	state.move_selection(1);
	let rows = state.filtered_items();
	let expected = rows
		.get(1)
		.or_else(|| rows.first())
		.map(|item| item.title.clone());
	assert_eq!(
		state.selected_item().map(|item| item.title.clone()),
		expected,
		"moving the selection walks the ranked order"
	);
	assert!(
		matches!(state.selected_item().map(|item| &item.kind), Some(PaletteItemKind::Command { .. })),
		"the seeded rows are commands"
	);

	let intent = state.run_intent();
	assert!(
		matches!(intent, Some(Intent::NewSession)),
		"the highlighted row runs its own intent, got {intent:?}"
	);
}

/// A ranked list draws each heading once. Scoring scatters a heading's rows
/// across the order, so the ranking regroups them; without that the surface
/// states the same provider several times down one list.
#[test]
fn a_ranked_list_draws_each_heading_once() {
	let mut state = PaletteState::new(PaletteMode::Models);
	// Equal-scoring titles, so the order is the authored one and the headings
	// arrive interleaved rather than in runs.
	state.set_items(
		(0..12)
			.map(|index| {
				let mut item = PaletteItem::command(
					index as u64 + 1,
					format!("alpha-{index}"),
					Intent::NewSession,
					None,
				);
				item.group = Some(format!("provider-{}", index % 3));
				item
			})
			.collect(),
	);
	state.set_query("alpha");

	let rows = state.filtered_items();
	assert_eq!(rows.len(), 12, "every row answers the query");
	let headings: Vec<&str> = rows
		.iter()
		.map(|row| row.group.as_deref().unwrap_or(""))
		.collect();
	let mut runs: Vec<&str> = Vec::new();
	for heading in &headings {
		if runs.last() != Some(heading) {
			runs.push(heading);
		}
	}
	assert_eq!(
		runs,
		["provider-0", "provider-1", "provider-2"],
		"the ranked order draws {headings:?}, restating a heading the list already drew"
	);
}
