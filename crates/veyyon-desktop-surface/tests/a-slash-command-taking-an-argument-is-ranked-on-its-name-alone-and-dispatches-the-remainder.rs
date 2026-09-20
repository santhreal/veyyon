//! WHY: a slash command that takes a trailing argument (such as `/goal
//! <objective>`) was scored against the entire query including its argument.
//! Because the row title only holds the command name, typing an argument caused
//! the fuzzy ranker to drop the row or score unrelated rows higher.
//! Furthermore, the palette dispatch dropped or ignored the argument rather
//! than forwarding it to the corresponding host action or client intent.
//!
//! CLASS CLOSED: every command row that declares `takes_argument` survives a
//! query containing its name followed by arbitrary trailing text (with various
//! whitespace and casings), and when dispatched, its intent carries the
//! trailing remainder verbatim including interior spaces. For `/goal`, an empty
//! remainder toggles the goal card (`Intent::ToggleGoalCard`), while a
//! non-empty remainder sets the goal objective (`Intent::SetGoal`). The variant
//! space sweeps all rows in `command_items()` that declare `takes_argument`.
//!
//! GAPS: fuzzy spelling of command names with arguments (e.g. `/gl`) does not
//! identify the argument boundary and still consumes the whole query. What
//! `/goal` does with its remainder once dispatched is
//! `crates/veyyon-desktop-surface/tests/
//! the-words-typed-after-a-slash-goal-reach-the-goal-they-name.rs`.

#[path = "support/slash-argument/mod.rs"]
mod slash_argument;

use std::{cell::RefCell, rc::Rc};

use slash_argument::{cases, options, selected_for, shell};
use veyyon_desktop_model::GoalControl;
use veyyon_desktop_scene::{HeadlessSession, headless::headless_context};
use veyyon_desktop_surface::{
	Intent, PaletteMode, PaletteState, fixture,
	palette::{PaletteItem, PaletteItemKind, command_takes_argument, commands::command_items},
};

#[test]
fn every_command_row_declaring_takes_argument_survives_a_query_with_arbitrary_text() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let state = fixture::populated();
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(state, Rc::clone(&drained))).expect("opens");

	let argument_rows: Vec<PaletteItem> = command_items()
		.into_iter()
		.filter(|item| item.takes_argument)
		.collect();
	assert!(
		!argument_rows.is_empty(),
		"at least one command row declares that it takes a trailing argument"
	);

	let samples = [
		"fix the failing tests",
		"Keep the desktop   parity   ledger honest",
		"arbitrary argument text with   multiple   spaces",
		"!@#$%^&*() punctuation and symbols",
	];

	for item in argument_rows {
		let name = item.title.as_str();
		assert!(
			command_takes_argument(name),
			"{name} must be recognized as taking an argument by command_takes_argument"
		);
		for typed in cases(name) {
			for sample in samples {
				let draft = format!("{typed} {sample}");
				assert_eq!(
					selected_for(&mut session, &draft).as_deref(),
					Some(name),
					"{draft:?} must select row {name} despite arbitrary trailing argument"
				);
			}
		}
	}
}

#[test]
fn every_argument_row_dispatches_something_other_than_its_bare_intent() {
	// Two mechanisms carry a remainder, and a row declaring an argument
	// reaches exactly one of them: a command row builds its intent from the
	// words typed after it, and a composer row hands the draft to the
	// composer, which
	// `a-slash-command-reaches-its-row-and-keeps-the-message-after-it.rs`
	// drives end to end. A row that declares an argument and reaches neither
	// drops the operator's words in silence. The sweep is over
	// `command_items()` at run time, so a row added later fails here until
	// its remainder reaches one of them.
	let argument_rows: Vec<PaletteItem> = command_items()
		.into_iter()
		.filter(|item| item.takes_argument)
		.collect();
	assert!(!argument_rows.is_empty(), "at least one command row takes a trailing argument");

	for item in argument_rows {
		let name = item.title.as_str();
		match &item.kind {
			PaletteItemKind::Command { .. } => {},
			PaletteItemKind::Composer { command } => {
				assert!(
					command.carries_draft(),
					"{name} takes an argument and the composer does not carry its draft"
				);
				continue;
			},
			other => panic!("{name} takes an argument and {other:?} carries it nowhere"),
		}
		let bare = item
			.intent_for_typed(name)
			.expect("a command row dispatches an intent");
		let carried = item
			.intent_for_typed(&format!("{name} an objective the operator typed"))
			.expect("a command row dispatches an intent");
		assert_ne!(
			bare, carried,
			"{name} takes an argument, so its remainder must change what it dispatches"
		);
		assert_ne!(
			item.intent_for_typed(&format!("{name}   ")).as_ref(),
			Some(&carried),
			"{name} with only whitespace after it is the bare command, not an argument"
		);
	}
}

#[test]
fn a_command_that_takes_no_argument_does_not_survive_arbitrary_trailing_text() {
	let mut cx = headless_context().expect("headless context available");
	let drained = Rc::new(RefCell::new(Vec::new()));
	let state = fixture::populated();
	let mut session =
		HeadlessSession::open(&mut cx, &options(), shell(state, Rc::clone(&drained))).expect("opens");

	let fixed_rows = ["/new", "/clear", "/history", "/files"];
	for name in fixed_rows {
		assert!(!command_takes_argument(name), "{name} must NOT be recognized as taking an argument");
		let draft = format!("{name} some totally unrelated text that cannot match");
		let selected = selected_for(&mut session, &draft);
		assert_ne!(
			selected.as_deref(),
			Some(name),
			"{draft:?} must not select {name} because it does not take arguments"
		);
	}
}

/// The words `/goal` takes are the terminal's own
/// (`packages/coding-agent/src/goals/subcommands.ts`): a control word reaches
/// the goal that is running, and anything else is an objective. Dispatching an
/// objective named "pause" would stand a goal up instead of standing it down,
/// which is the reverse of what the operator asked for.
#[test]
fn the_words_goal_takes_are_the_words_the_terminal_takes() {
	let goal = command_items()
		.into_iter()
		.find(|item| item.title == "/goal")
		.expect("the palette offers /goal");

	let control = |typed: &str| goal.intent_for_typed(typed);
	assert_eq!(
		control("/goal pause"),
		Some(Intent::ControlGoal { op: GoalControl::Pause }),
		"a goal is paused, not renamed to `pause`"
	);
	assert_eq!(control("/goal RESUME"), Some(Intent::ControlGoal { op: GoalControl::Resume }));
	assert_eq!(control("goal drop"), Some(Intent::ControlGoal { op: GoalControl::Drop }));
	assert_eq!(control("/goal show"), Some(Intent::ToggleGoalCard));
	assert_eq!(
		control("/goal set ship the parity work"),
		Some(Intent::SetGoal {
			objective:    "ship the parity work".to_string(),
			token_budget: None,
		}),
		"`set` names the objective that follows it"
	);
	assert_eq!(
		control("/goal pause the release until the gate is green"),
		Some(Intent::ControlGoal { op: GoalControl::Pause }),
		"the first word decides, the same as the terminal's parse"
	);
	assert_eq!(
		control("/goal paused work on the ledger"),
		Some(Intent::SetGoal {
			objective:    "paused work on the ledger".to_string(),
			token_budget: None,
		}),
		"a word that merely starts like a control word is an objective"
	);
	assert_eq!(
		control("/goal set"),
		Some(Intent::SetGoal { objective: "set".to_string(), token_budget: None }),
		"`set` with nothing after it is the objective it names"
	);
}

/// The command palette holds the whole typed query, so the argument reaches
/// the intent there too: the goal scene drives `/goal pause` through ctrl+k,
/// and a row ranked on its name alone that then runs bare would stand a
/// paused goal back up.
#[test]
fn the_command_palette_runs_a_row_with_the_argument_typed_into_it() {
	let mut palette = PaletteState::new(PaletteMode::Commands);
	palette.set_items(command_items());

	palette.set_query("goal pause");
	assert_eq!(
		palette
			.selected_item()
			.map(|item| item.title.clone())
			.as_deref(),
		Some("/goal"),
		"a query naming an argument row selects it despite the argument"
	);
	assert_eq!(
		palette.run_intent(),
		Some(Intent::ControlGoal { op: GoalControl::Pause }),
		"the palette runs the row with what was typed after its name"
	);

	palette.set_query("goal Keep the parity ledger honest");
	assert_eq!(
		palette.run_intent(),
		Some(Intent::SetGoal {
			objective:    "Keep the parity ledger honest".to_string(),
			token_budget: None,
		}),
		"an objective typed into the command palette reaches the intent verbatim"
	);

	palette.set_query("goal");
	assert_eq!(
		palette.run_intent(),
		Some(Intent::ToggleGoalCard),
		"the row's own spelling runs the row's own intent"
	);
}
