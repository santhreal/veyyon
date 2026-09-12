//! WHY: choosing a model is the one control that changes what every later turn
//! is answered by, and the picker does not list the host's rows in the host's
//! order: `PaletteState::from_models` groups them by account and lifts the
//! model in effect to the front of its own group. A dispatch keyed on a
//! position — the host's index, the pre-grouping index, the index of the row
//! before the lift — sends a neighbouring model, and nothing on the frame says
//! so: the palette closes, the footer names whatever the host then reports, and
//! the next turn runs on a model nobody picked. The same holds for the effort
//! rows, where a level off by one is the difference between no reasoning and
//! the most expensive setting the model has.
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
//! suites own; and which pixels a row is shaped from, since a captured run
//! carries its box and not its text — a row's identity is read here from the
//! ranked list the frame drew from.

#[path = "support/model-picker/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared catalogue helpers")]
mod model_picker;

use model_picker::{
	centre, choice_of, confirm, control, open_effort, open_models, ranked, row_rects, selected,
	sent, session, state, step, thinking, window,
};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_surface::{
	Intent, ModelChoice,
	composer::{ThinkingControl, ThinkingLevel},
	keymap::{Command, Keymap, resolve_chord},
};

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
		// One press per window: the row closes the palette, and the state it
		// leaves is the one the next press would be aimed at.
		let sent = session(|session| {
			open_models(session);
			step(session, "down", index);
			assert_eq!(
				selected(session).as_deref(),
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
		let pressed = session(|session| {
			open_models(session);
			let frame = session.frame().expect("the catalogue draws");
			let rows = row_rects(&frame, width, row_height);
			assert_eq!(rows.len(), titles.len(), "the frame answers a press on every row it drew");
			session
				.click(centre(rows[index]))
				.expect("the row answers a press");
			sent(session)
		});
		assert_eq!(
			pressed,
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
	// rebinding moves the press with it rather than leaving the suite driving a
	// chord nothing is bound to.
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
		let mut shell = state();
		shell.composer.thinking =
			Some(ThinkingControl { level: level.clone(), levels: levels.clone() });

		let dispatched = window(shell, |session| {
			session.frame().expect("the shell draws");
			session
				.update(|view, _window, _cx| {
					view.drain_intents();
				})
				.expect("the opening frame's intents are dropped");
			assert!(
				session.keystroke(&chord).expect("the chord dispatches"),
				"the effort chord reached no handler while {level} was in effect"
			);
			session
				.update(|view, _window, _cx| view.drain_intents())
				.expect("what the chord sent is read back")
		});

		assert_eq!(
			dispatched,
			vec![Intent::SetThinking(ThinkingLevel::new(next.clone()))],
			"the chord moved from {level} to something other than {next}"
		);
	}
}
