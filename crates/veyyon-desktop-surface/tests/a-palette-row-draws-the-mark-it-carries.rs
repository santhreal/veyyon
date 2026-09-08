//! WHY: every palette row was built with a leading state dot and a trailing
//! mark — the chord that runs a command, the partition a session sits in, the
//! kind of a browse entry, whether a model reasons — and the renderer drew
//! neither. The work was done on every keystroke and thrown away, so the
//! palette taught no chord and a session's state vanished the moment it was
//! searched for instead of scrolled to. The chord was also written by hand as
//! `Cmd/Ctrl N` beside a `keymap.toml` that already declared `primary-n`, so
//! an operator override changed the binding and not the row that stated it.
//!
//! The class this closes is "a mark a palette row carries never reaches the
//! frame, or reaches it from a second copy of the keymap". The variant space
//! is `PaletteMeta`, matched exhaustively here, so a variant added later does
//! not compile until this suite states what it draws.
//!
//! NOT CAUGHT: which glyphs a chord chip is shaped from, since a captured text
//! run carries its size and its box and not its characters. The chord string
//! itself is asserted against the keymap directly, and the frame is asserted
//! to gain the runs that draw it.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::KeybindingView;
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	Badge, Intent, ModelChoice, Overlay, PaletteItem, PaletteItemKind, PaletteMode, PaletteState,
	Row, Section, ShellView,
	composer::{ModelControl, ModelOption},
	fixture, install_tokens,
	keymap::{Keymap, OverrideReport, command::Command},
	palette::{PaletteMeta, commands::command_items},
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// Captures the shell with `palette` open, so the rows under test are the ones
/// the window actually draws rather than a fixture of them.
fn captured(cx: &mut veyyon_gpui::HeadlessAppContext, palette: PaletteState) -> Captured {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	render_view_captured(cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut state = fixture::populated();
			state.overlay = Some(Overlay::Palette(palette));
			ShellView::new(installed, state)
		})
	})
	.expect("the shell renders offscreen")
}

/// The same rows with every mark taken off, which is what the renderer drew
/// before: the control arm proving the marks are what changed the frame.
fn unmarked(state: &PaletteState) -> PaletteState {
	let mut stripped = state.clone();
	for item in &mut stripped.items {
		item.meta = None;
		item.badge = None;
	}
	stripped
}

fn model_control() -> ModelControl {
	let plain = ModelChoice { provider: "aimlapi".into(), model: "alibaba/qwen-max".into() };
	let thinker = ModelChoice { provider: "aimlapi".into(), model: "qwen3-thinking".into() };
	// A second account, listed before the one holding the model in effect, so
	// the heading order under test is not the order the host reported.
	let other = ModelChoice { provider: "openrouter".into(), model: "z-ai/glm-4.7".into() };
	ModelControl {
		current:    Some(plain.clone()),
		options:    vec![
			ModelOption {
				choice:    other,
				name:      "GLM 4.7".into(),
				reasoning: true,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    plain,
				name:      "alibaba/qwen-max".into(),
				reasoning: false,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    thinker,
				name:      "Qwen3 Thinking".into(),
				reasoning: true,
				input:     Vec::new(),
			},
		],
		selectable: true,
	}
}

fn session_rows() -> Vec<(Section, Vec<Row>)> {
	vec![(Section::Live, vec![Row {
		id:       7,
		title:    "port the loader".into(),
		subtitle: "ws-default".into(),
		badge:    Some(Badge::Working),
		meta:     None,
	}])]
}

/// Every palette state a producer builds, named for the mode it opens in.
fn every_producer() -> Vec<(&'static str, PaletteState)> {
	let mut browse = PaletteState::new(PaletteMode::Browse);
	browse.items = vec![PaletteItem::directory(1, "crates/veyyon-desktop")];
	vec![
		("commands", PaletteState::commands()),
		("sessions", PaletteState::from_sessions(&session_rows())),
		("models", PaletteState::from_models(&model_control())),
		("browse", browse),
	]
}

fn text_run_count(captured: &Captured) -> usize {
	captured.text_runs.len()
}

#[test]
fn every_mark_a_producer_sets_reaches_the_frame() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	for (name, state) in every_producer() {
		let marks = state
			.items
			.iter()
			.filter(|item| item.meta.is_some() || item.badge.is_some())
			.count();
		assert!(marks > 0, "{name}: this producer sets no mark at all, so it proves nothing");

		let with = text_run_count(&captured(&mut cx, state.clone()));
		let without = text_run_count(&captured(&mut cx, unmarked(&state)));
		assert!(
			with > without,
			"{name}: {marks} rows carry a mark and the frame drew the same {with} text runs either \
			 way, so the mark reaches nothing"
		);
	}
}

#[test]
fn every_kind_of_mark_is_drawn_as_its_own_kind() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let chord = PaletteMeta::Chord(Command::NewSession);
	let note = PaletteMeta::Note("Live".to_string());
	// Exhaustive on purpose: a variant added to `PaletteMeta` fails to compile
	// here until this suite states how it is drawn and proves it.
	for mark in [chord, note] {
		let drawn = match &mark {
			PaletteMeta::Chord(_) => mark.chord(&Keymap::default()),
			PaletteMeta::Note(note) => Some(note.clone()),
		};
		let text = drawn.unwrap_or_else(|| panic!("{mark:?} states nothing to draw"));
		assert!(!text.is_empty(), "{mark:?} draws an empty mark");

		let mut state = PaletteState::new(PaletteMode::Commands);
		state.items = vec![PaletteItem {
			id:       1,
			title:    "/new".into(),
			subtitle: Some("Create a new session".into()),
			group:    None,
			badge:    None,
			meta:     Some(mark.clone()),
			kind:     PaletteItemKind::Command { intent: Box::new(Intent::NewSession) },
		}];
		let with = text_run_count(&captured(&mut cx, state.clone()));
		let without = text_run_count(&captured(&mut cx, unmarked(&state)));
		assert!(with > without, "{mark:?} drew no run of its own: {with} runs either way");
	}
}

#[test]
fn a_row_states_the_chord_the_operator_bound_not_the_one_shipped() {
	let shipped = Keymap::default();
	let mark = PaletteMeta::Chord(Command::NewSession);
	assert_eq!(
		mark.chord(&shipped).as_deref(),
		Some("primary-n"),
		"the shipped chord is read from the keymap table, not written beside it"
	);

	let mut overridden = Keymap::default();
	let reports = overridden.apply_overrides(&[KeybindingView {
		action: "NewSession".to_string(),
		keys:   vec!["primary-alt-n".to_string()],
		source: "user".to_string(),
	}]);
	assert!(
		reports
			.iter()
			.all(|report| !matches!(report, OverrideReport::InvalidChord { .. })),
		"the override under test must be a chord the table accepts: {reports:?}"
	);
	assert_eq!(
		mark.chord(&overridden).as_deref(),
		Some("primary-alt-n"),
		"the row states the chord that runs today, so an override reaches it"
	);
}

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

	let current = state
		.items
		.iter()
		.find(|item| item.title == "alibaba/qwen-max")
		.expect("the catalogue lists the model in effect");
	assert_eq!(
		current.meta,
		Some(PaletteMeta::Note("in effect".to_string())),
		"the model in effect says so, since order alone says nothing once the list is filtered"
	);
	let thinker = state
		.items
		.iter()
		.find(|item| item.title == "Qwen3 Thinking")
		.expect("the catalogue lists the reasoning model");
	assert_eq!(
		thinker.meta,
		Some(PaletteMeta::Note("reasoning".to_string())),
		"a model that reasons says so"
	);
}

#[test]
fn a_command_the_keymap_binds_states_its_chord_and_one_it_does_not_states_none() {
	let keymap = Keymap::default();
	let items = command_items();
	let bound: Vec<&str> = items
		.iter()
		.filter(|item| {
			item
				.meta
				.as_ref()
				.and_then(|mark| mark.chord(&keymap))
				.is_some()
		})
		.map(|item| item.title.as_str())
		.collect();
	assert_eq!(
		bound,
		vec!["/new", "/terminal", "/abort", "/attach", "/model", "/effort", "/queue-mode"],
		"exactly the commands the keymap binds state a chord"
	);
}

/// WHY: the catalogue listed every model as a flat run of rows and repeated the
/// provider on each one, so two accounts serving the same name read as
/// duplicates and the account holding the model in effect was not stated. The
/// class this closes is "a grouped palette list states its heading per row, out
/// of order, or not at all".
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
	let control = model_control();
	let grouped = PaletteState::from_models(&control);
	let mut flat = grouped.clone();
	for item in &mut flat.items {
		item.group = None;
	}
	let with = text_run_count(&captured(&mut cx, grouped.clone()));
	let without = text_run_count(&captured(&mut cx, flat));
	assert_eq!(
		with - without,
		2,
		"one run per heading and no more: {with} runs grouped against {without} flat"
	);
}

/// WHY: the row window was taken as the eight rows before the selection, so a
/// heading drawn among them pushed the selected row out of the frame and the
/// arrow keys moved a selection nothing showed. The class this closes is "the
/// row the operator selected is not one of the rows drawn".
#[test]
fn the_selected_row_is_one_of_the_rows_a_grouped_list_draws() {
	let items: Vec<PaletteItem> = (0..40)
		.map(|index| {
			let mut item =
				PaletteItem::command(index + 1, format!("model-{index}"), Intent::NewSession, None);
			// Three rows per account, so the window under test carries a
			// heading every third row rather than one at the top.
			item.group = Some(format!("account-{}", index / 3));
			item
		})
		.collect();
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
