//! WHY: the model picker listed every model the host reported as one flat run
//! of rows and repeated the provider on each row, so two accounts serving the
//! same model read as duplicates, the account holding the model in effect was
//! not stated anywhere, and the second line under a row restated the name
//! already drawn above it.
//!
//! CLASS CLOSED: a grouped palette list whose heading is stated per row, out of
//! order, more than once, or not at all; a row window that draws the selected
//! row outside the frame once headings take room; and a list that grows past
//! the surface's own ceiling instead of drawing fewer rows.
//!
//! NOT CAUGHT: which characters a heading is shaped from, since a captured text
//! run carries its size and its box and not its text. The heading string is
//! asserted against the provider the host reported, and the frame is asserted
//! to gain exactly one run per heading.

use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{
	ModelChoice, PaletteItem, PaletteMode, PaletteState,
	composer::{ModelControl, ModelOption},
};

#[path = "support/palette-rows/mod.rs"]
mod palette_rows;

use palette_rows::{captured, grouped_rows, model_control, text_run_count};

#[test]
fn a_model_row_does_not_restate_the_name_above_it() {
	let control = model_control();
	let state = PaletteState::from_models(&control);
	for item in &state.items {
		let heading = item
			.group
			.as_deref()
			.unwrap_or_else(|| panic!("{} sits under no heading", item.title));
		if let Some(subtitle) = item.subtitle.as_deref() {
			assert!(
				!subtitle.contains(&item.title),
				"{}: the line under the row repeats the row: {subtitle}",
				item.title
			);
			assert!(
				!subtitle.contains(heading),
				"{}: the line under the row repeats the heading above it: {subtitle}",
				item.title
			);
		} else {
			// No second line is only correct when the title is the id already,
			// so nothing is withheld from the row by leaving it off.
			let option = control
				.options
				.iter()
				.find(|option| option.name == item.title)
				.expect("every row comes from a reported option");
			assert_eq!(
				option.choice.model, item.title,
				"{}: the row states no id and its title is not the id either",
				item.title
			);
		}
	}
}

#[test]
fn a_provider_is_stated_once_above_the_models_it_holds() {
	let control = model_control();
	let state = PaletteState::from_models(&control);
	let headings: Vec<&str> = state
		.items
		.iter()
		.filter_map(|item| item.group.as_deref())
		.collect();
	let mut seen: Vec<&str> = Vec::new();
	for heading in &headings {
		if seen.last() != Some(heading) {
			assert!(
				!seen.contains(heading),
				"{heading} opens a second time, so its rows are not contiguous: {headings:?}"
			);
			seen.push(heading);
		}
	}
	assert_eq!(
		seen,
		vec!["aimlapi", "openrouter"],
		"the account holding the model in effect leads, whatever order the host listed"
	);
	assert_eq!(
		state.items.first().map(|item| item.title.as_str()),
		Some("alibaba/qwen-max"),
		"the model in effect is the first row under the first heading"
	);
}

#[test]
fn a_heading_reaches_the_frame_and_takes_its_room_from_the_rows() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let grouped = PaletteState::from_models(&model_control());
	let mut flat = grouped.clone();
	for item in &mut flat.items {
		item.group = None;
	}
	let with = text_run_count(&captured(&mut cx, grouped));
	let without = text_run_count(&captured(&mut cx, flat));
	assert_eq!(
		with - without,
		2,
		"one run per heading and no more: {with} runs grouped against {without} flat"
	);

	// The rows and the headings share one surface, so a list longer than the
	// surface draws only the rows that still fit: the same frame a list of
	// exactly those rows draws.
	let mut long = PaletteState::new(PaletteMode::Models);
	long.items = grouped_rows(40);
	let mut fitting = PaletteState::new(PaletteMode::Models);
	fitting.items = grouped_rows(40).into_iter().take(7).collect();
	let drawn = text_run_count(&captured(&mut cx, long));
	let fits = text_run_count(&captured(&mut cx, fitting));
	assert_eq!(
		drawn, fits,
		"a list of 40 rows drew {drawn} runs where the 7 rows that fit draw {fits}, so the rows the \
		 headings displaced were drawn past the bottom anyway"
	);
}

#[test]
fn the_selected_row_is_one_of_the_rows_a_grouped_list_draws() {
	let items = grouped_rows(40);
	let filtered: Vec<&PaletteItem> = items.iter().collect();
	let room = 420.0 - 40.0 - 32.0;
	for selected in 0..filtered.len() {
		let start = PaletteState::window_start(&filtered, selected, room, 36.0, 20.0);
		assert!(
			start <= selected,
			"the window starts past the selection: {start} for row {selected}"
		);
		let mut used = 20.0;
		let mut group = filtered[start].group.as_deref();
		for item in &filtered[start..=selected] {
			if item.group.as_deref() != group {
				group = item.group.as_deref();
				used += 20.0;
			}
			used += 36.0;
		}
		assert!(
			used <= room,
			"row {selected} is {used} into a {room} surface, so it is drawn past the bottom"
		);
	}
}

#[test]
fn a_search_keeps_the_rows_under_one_heading_together() {
	// Two accounts serving models whose names rank one account's rows either
	// side of the other's, which is what splits a provider once the list is
	// ordered by score alone.
	let control = ModelControl {
		current:    None,
		options:    vec![
			ModelOption {
				choice:    ModelChoice { provider: "aimlapi".into(), model: "glm".into() },
				name:      "glm".into(),
				reasoning: false,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    ModelChoice { provider: "openrouter".into(), model: "glm-4.7".into() },
				name:      "glm-4.7".into(),
				reasoning: false,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    ModelChoice {
					provider: "aimlapi".into(),
					model:    "glm-4.5-air-nitro-long".into(),
				},
				name:      "glm-4.5-air-nitro-long".into(),
				reasoning: false,
				input:     Vec::new(),
			},
		],
		selectable: true,
	};
	let mut grouped = PaletteState::from_models(&control);
	grouped.set_query("glm");

	// The control arm: the same rows carrying no heading, ranked by score
	// alone. This is the order the fix reorders, and the test states nothing
	// unless that order really does split an account.
	let mut ranked = grouped.clone();
	for item in &mut ranked.items {
		item.group = None;
	}
	let account = |title: &str| {
		control
			.options
			.iter()
			.find(|option| option.name == title)
			.map(|option| option.choice.provider.as_str())
			.expect("every row comes from a reported option")
	};
	let by_score: Vec<&str> = ranked
		.filtered_items()
		.iter()
		.map(|item| account(&item.title))
		.collect();
	assert_eq!(
		by_score,
		vec!["aimlapi", "openrouter", "aimlapi"],
		"score alone no longer splits an account, so this fixture proves nothing"
	);

	let filtered = grouped.filtered_items();
	let mut seen: Vec<&str> = Vec::new();
	for item in &filtered {
		let heading = item
			.group
			.as_deref()
			.unwrap_or_else(|| panic!("{} sits under no heading", item.title));
		if seen.last() != Some(&heading) {
			assert!(
				!seen.contains(&heading),
				"{heading} is stated a second time: {:?}",
				filtered
					.iter()
					.map(|row| (row.group.as_deref(), row.title.as_str()))
					.collect::<Vec<_>>()
			);
			seen.push(heading);
		}
	}
	assert_eq!(filtered.len(), 3, "the query dropped a row the ranking matched");
}
