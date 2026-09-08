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
//! to gain the runs that draw it. How a row states the account serving it is
//! `a-model-picker-states-the-account-above-the-models-it-serves.rs`.

use veyyon_desktop_model::KeybindingView;
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{
	Badge, Intent, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, Row, Section,
	keymap::{Keymap, OverrideReport, command::Command},
	palette::{PaletteMeta, commands::command_items},
};

#[path = "support/palette-rows/mod.rs"]
mod palette_rows;

use palette_rows::{captured, model_control, text_run_count};

/// The same rows with every mark taken off, which is what the renderer drew
/// before: the control arm proving the marks are what changed the frame.
fn unmarked(state: &PaletteState) -> PaletteState {
	let mut stripped = state.clone();
	let mut items = state.items().to_vec();
	for item in &mut items {
		item.meta = None;
		item.badge = None;
	}
	stripped.set_items(items);
	stripped
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
	browse.set_items(vec![PaletteItem::directory(1, "crates/veyyon-desktop")]);
	vec![
		("commands", PaletteState::commands()),
		("sessions", PaletteState::from_sessions(&session_rows())),
		("models", PaletteState::from_models(&model_control())),
		("browse", browse),
	]
}

#[test]
fn every_mark_a_producer_sets_reaches_the_frame() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	for (name, state) in every_producer() {
		let marks = state
			.items()
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
		state.set_items(vec![PaletteItem {
			id:         1,
			title:      "/new".into(),
			subtitle:   Some("Create a new session".into()),
			group:      None,
			search:     None,
			badge:      None,
			meta:       Some(mark.clone()),
			capability: None,
			kind:       PaletteItemKind::Command { intent: Box::new(Intent::NewSession) },
		}]);
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
fn a_model_row_states_which_model_is_in_effect_and_which_reasons() {
	let state = PaletteState::from_models(&model_control());
	let current = state
		.items()
		.iter()
		.find(|item| item.title == "alibaba/qwen-max")
		.expect("the catalogue lists the model in effect");
	assert_eq!(
		current.meta,
		Some(PaletteMeta::Note("in effect".to_string())),
		"the model in effect says so, since order alone says nothing once the list is filtered"
	);
	let thinker = state
		.items()
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
