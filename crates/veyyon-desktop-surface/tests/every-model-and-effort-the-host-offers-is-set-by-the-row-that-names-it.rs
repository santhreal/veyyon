//! WHY: choosing a model is the one control that changes what every later turn
//! is answered by, and the picker does not list the host's rows in the host's
//! order: `PaletteState::from_models` groups them by account and lifts the
//! model in effect to the front of its own group. A dispatch keyed on a
//! position — the host's index, the pre-grouping index, the index of the row
//! before the lift — sends a neighbouring model, and nothing on the frame says
//! so: the palette closes, the footer names whatever the host then reports, and
//! the operator's next turn runs on a model nobody picked. The same holds for
//! the effort rows, where a level off by one is the difference between no
//! reasoning and the most expensive setting the model has.
//!
//! CLASS CLOSED: every model the host reported and every effort level it
//! reported, reached by the row that names it and pressed the way an operator
//! presses it — the keyboard walking the ranked list and the pointer landing on
//! the drawn row. The sweeps are derived from the reported catalogue at run
//! time rather than from a list written here, so a model or a level added to
//! the host's answer is swept too, and each sweep asserts the choices it
//! collected are exactly the catalogue: a row that sends a neighbour's model
//! shows up as one model sent twice and one never sent, which a per-row
//! assertion alone would pass for the row that happens to be right. Held shut
//! against:
//!
//! 1. A row wired to another row's model or level, including the off-by-one the
//!    account grouping and the lift of the model in effect introduce.
//! 2. A model or a level the list holds and no press can reach.
//! 3. A pointer press that chooses a different row than the keyboard would at
//!    the same position, which is what a row drawn outside its own hit rect or
//!    a window offset applied on one path and not the other looks like.
//! 4. A level chord that stays put, skips a level, or runs off the end of the
//!    list instead of wrapping.
//! 5. A press that leaves the palette open, so the next keystroke lands in a
//!    surface the operator believes is gone.
//!
//! NOT CAUGHT: what the host does with the choice, which
//! `every-action-the-host-answers-has-a-control-that-sends-it` and the bridge
//! suites own; and which pixels the row is shaped from, since a captured run
//! carries its box and not its text — the row's identity is read here from the
//! ranked list the frame drew from.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	Captured,
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ModelChoice, ModelControl, ModelOption, Overlay, ShellState, ShellView,
	composer::{ThinkingControl, ThinkingLevel},
	fixture, install_tokens,
	keymap::{Command, resolve_chord},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point};

const WINDOW_W: u32 = 1440;
const WINDOW_H: u32 = 900;

/// The catalogue the host reported: three accounts, one of them serving two
/// models, and the model in effect listed last so both the grouping and the
/// lift of the active row move it away from the position the host gave it.
fn control() -> ModelControl {
	let option = |provider: &str, model: &str, name: &str, reasoning: bool| ModelOption {
		choice: ModelChoice::new(provider, model),
		name: name.to_owned(),
		reasoning,
		input: Vec::new(),
	};
	ModelControl {
		current: Some(ModelChoice::new("aimlapi", "qwen3-thinking")),
		options: vec![
			option("openrouter", "z-ai/glm-4.7", "GLM 4.7", true),
			option("anthropic", "claude-opus-4.1", "Claude Opus 4.1", true),
			option("aimlapi", "alibaba/qwen-max", "alibaba/qwen-max", false),
			option("anthropic", "claude-sonnet-4.5", "Claude Sonnet 4.5", true),
			option("aimlapi", "qwen3-thinking", "Qwen3 Thinking", true),
		],
	}
}

/// The levels the host reported, with the third of four in effect, so a chord
/// that wraps is told apart from one that saturates at the end.
fn thinking() -> ThinkingControl {
	ThinkingControl {
		level:  "medium".to_owned(),
		levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	}
}

/// The shell with that catalogue in the footer.
fn state() -> ShellState {
	let mut state = fixture::populated();
	state.composer.model = Some(control());
	state.composer.thinking = Some(thinking());
	state
}

/// A live window with the keymap bound, so a chord reaches the same handler it
/// reaches in the product rather than a listener the test installed.
fn session<R>(test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("a headless renderer is required");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state()))
	})
	.expect("the window opens offscreen");
	test(&mut session)
}

/// Opens the model catalogue the way the composer's chip and the composer chord
/// both open it, and drops the overlay intent so what a press sends is read on
/// its own.
fn open_models(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, window, cx| {
			view.open_model_picker(window, cx);
			view.drain_intents();
		})
		.expect("the catalogue opens");
	session.frame().expect("the catalogue draws");
}

/// Opens the effort rows the way an operator reaches them: the command surface,
/// the command's own spelling typed into it, and the row it leaves selected
/// run by the return key.
fn open_effort(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, window, cx| {
			view.open_command_palette(window, cx);
			view.drain_intents();
		})
		.expect("the command surface opens");
	session.frame().expect("the command surface draws");
	session.type_text("/effort").expect("the command is typed");
	session.frame().expect("the ranked frame draws");
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the command surface"
	);
	session.frame().expect("the effort rows draw");
}

/// The titles the palette ranked, in the order it drew them.
fn ranked(session: &mut HeadlessSession<'_, ShellView>) -> Vec<String> {
	session
		.update(|view, _window, _cx| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.expect("a palette is open")
				.filtered_items()
				.iter()
				.map(|item| item.title.clone())
				.collect()
		})
		.expect("the ranked rows are read back")
}

/// What the row titled `title` must send, read from the host's own catalogue
/// rather than from the list the palette built out of it.
fn choice_of(title: &str) -> ModelChoice {
	control()
		.options
		.iter()
		.find(|option| option.name == title)
		.map(|option| option.choice.clone())
		.unwrap_or_else(|| panic!("{title} is a row the host never reported"))
}

/// Presses the return key and reports what the shell sent for the host.
fn confirm(session: &mut HeadlessSession<'_, ShellView>) -> Vec<Intent> {
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the palette"
	);
	session
		.update(|view, _window, _cx| {
			assert!(
				view.state().overlay.is_none(),
				"the palette stayed open behind the row that was run"
			);
			view.drain_intents()
		})
		.expect("what the press sent is read back")
}

/// Steps the selection `down` rows from the row a fresh palette rests on.
fn step(session: &mut HeadlessSession<'_, ShellView>, chord: &str, times: usize) {
	for _ in 0..times {
		assert!(
			session.keystroke(chord).expect("the arrow key dispatches"),
			"the {chord} key reached no handler over the palette"
		);
	}
	session.frame().expect("the moved selection draws");
}

/// Every row rect the palette drew: a hit rect the height the results tokens
/// author, inside the surface the palette geometry sizes.
///
/// Taken from the frame rather than computed, so a row drawn outside the box it
/// registered is missed by neither the press nor the count.
fn row_rects(frame: &Captured, width_px: f32, row_height_px: f32) -> Vec<Bounds<Pixels>> {
	let mut rows: Vec<Bounds<Pixels>> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			(f32::from(rect.size.height) - row_height_px).abs() < 1.0
				&& f32::from(rect.size.width) <= width_px + 1.0
				&& f32::from(rect.size.width) > width_px / 2.0
		})
		.collect();
	rows.sort_by(|a, b| {
		f32::from(a.origin.y)
			.partial_cmp(&f32::from(b.origin.y))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	rows.dedup();
	rows
}

fn centre(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}

#[test]
fn every_model_the_host_reported_is_chosen_by_the_row_that_names_it() {
	let titles = session(|session| {
		open_models(session);
		ranked(session)
	});
	assert_eq!(
		titles.len(),
		control().options.len(),
		"the catalogue lists a row per model the host reported"
	);

	let mut chosen: Vec<ModelChoice> = Vec::new();
	for (index, title) in titles.iter().enumerate() {
		// One press per window: the row closes the palette and the state it
		// leaves is the one the next press would be aimed at.
		let sent = session(|session| {
			open_models(session);
			step(session, "down", index);
			let selected = session
				.update(|view, _window, _cx| {
					view
						.state()
						.overlay
						.as_ref()
						.and_then(Overlay::as_palette)
						.and_then(veyyon_desktop_surface::PaletteState::selected_item)
						.map(|item| item.title.clone())
				})
				.expect("the selected row is read back");
			assert_eq!(
				selected.as_deref(),
				Some(title.as_str()),
				"{index} presses of the down key rest on another row than the list drew there"
			);
			confirm(session)
		});
		assert_eq!(
			sent,
			vec![Intent::SelectModel(choice_of(title))],
			"the row titled {title} sent another row's model"
		);
		if let Some(Intent::SelectModel(choice)) = sent.into_iter().next() {
			chosen.push(choice);
		}
	}

	let mut reported: Vec<ModelChoice> = control()
		.options
		.into_iter()
		.map(|option| option.choice)
		.collect();
	let key = |choice: &ModelChoice| (choice.provider.clone(), choice.model.clone());
	chosen.sort_by_key(key);
	reported.sort_by_key(key);
	assert_eq!(chosen, reported, "walking the list once chose each reported model exactly once");
}

#[test]
fn the_row_above_the_first_is_the_last_one_the_list_holds() {
	let titles = session(|session| {
		open_models(session);
		ranked(session)
	});
	let last = titles.last().expect("the catalogue drew rows").clone();

	let sent = session(|session| {
		open_models(session);
		step(session, "up", 1);
		confirm(session)
	});

	assert_eq!(
		sent,
		vec![Intent::SelectModel(choice_of(&last))],
		"the up key from the first row left the list instead of wrapping to its last row"
	);
}

#[test]
fn the_row_the_pointer_presses_chooses_what_the_keyboard_would() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let width = tokens.surface.palette.width_px;
	let row_height = tokens.surface.palette.results_row_height_px;

	let titles = session(|session| {
		open_models(session);
		ranked(session)
	});

	for (index, title) in titles.iter().enumerate() {
		let sent = session(|session| {
			open_models(session);
			let frame = session.frame().expect("the catalogue draws");
			let rows = row_rects(&frame, width, row_height);
			assert_eq!(rows.len(), titles.len(), "the frame answers a press on every row it drew");
			session
				.click(centre(rows[index]))
				.expect("the row answers a press");
			session
				.update(|view, _window, _cx| {
					assert!(
						view.state().overlay.is_none(),
						"the palette stayed open behind the row that was pressed"
					);
					view.drain_intents()
				})
				.expect("what the press sent is read back")
		});
		assert_eq!(
			sent,
			vec![Intent::SelectModel(choice_of(title))],
			"the pointer on row {index} chose a different model than the keyboard does"
		);
	}
}

#[test]
fn every_effort_the_host_reported_is_set_by_the_row_that_names_it() {
	let levels = session(|session| {
		open_effort(session);
		ranked(session)
	});
	assert_eq!(
		levels,
		thinking().levels,
		"the effort rows are the levels the host reported, in its order"
	);

	let mut set: Vec<String> = Vec::new();
	for (index, level) in levels.iter().enumerate() {
		let sent = session(|session| {
			open_effort(session);
			step(session, "down", index);
			confirm(session)
		});
		assert_eq!(
			sent,
			vec![Intent::SetThinking(ThinkingLevel::new(level.clone()))],
			"the row titled {level} set another row's level"
		);
		set.push(level.clone());
	}
	assert_eq!(set, thinking().levels, "walking the rows once set each level exactly once");
}

#[test]
fn the_effort_chord_steps_to_the_next_level_and_wraps_at_the_last() {
	let levels = thinking().levels;
	// The chord is read from the keymap and resolved for this platform, so a
	// rebinding moves the press with it rather than leaving the suite driving
	// a chord nothing is bound to.
	let chord = resolve_chord(
		&Keymap::default()
			.rows()
			.into_iter()
			.find(|row| row.command == Command::ThinkingLevel)
			.map(|row| row.chord)
			.expect("the keymap binds a chord to the thinking level"),
	);
	for (index, level) in levels.iter().enumerate() {
		let next = levels[(index + 1) % levels.len()].clone();
		let mut cx = headless_context().expect("a headless renderer is required");
		let tokens = load_bundled_tokens().expect("the bundled tokens load");
		let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
		let options = RenderOptions {
			width: WINDOW_W,
			height: WINDOW_H,
			scale_factor: 1.0,
			..RenderOptions::default()
		};
		let mut shell = state();
		shell.composer.thinking =
			Some(ThinkingControl { level: level.clone(), levels: levels.clone() });
		let mut window = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.bind_keys(Keymap::default().bindings());
			veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
			app.new(|_| ShellView::new(installed, shell))
		})
		.expect("the window opens offscreen");
		window.frame().expect("the shell draws");
		window
			.update(|view, _window, _cx| {
				view.drain_intents();
			})
			.expect("the opening frame's intents are dropped");

		assert!(
			window.keystroke(&chord).expect("the chord dispatches"),
			"the effort chord reached no handler while {level} was in effect"
		);
		let sent = window
			.update(|view, _window, _cx| view.drain_intents())
			.expect("what the chord sent is read back");
		assert_eq!(
			sent,
			vec![Intent::SetThinking(ThinkingLevel::new(next.clone()))],
			"the chord moved from {level} to something other than {next}"
		);
	}
}
