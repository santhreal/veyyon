//! WHY: a branch could only be cut at the end. The rail's row menu forked a
//! session at its last prompt, and that was the only fork the window could
//! ask for, however far back the operator had read: the host accepts any
//! entry on the branch and the window could name exactly one of them. The
//! turn the operator is looking at now offers the fork itself.
//!
//! CLASS CLOSED: a fork offered where the host would refuse it, and a fork
//! cut at a turn other than the one pressed. The offer is swept over the
//! `Turn` union, whose arms are named by an exhaustive match rather than by a
//! list here, so a turn kind added to the transcript decides whether it
//! carries a fork or this is red. Both readings are driven through the real
//! window: the menu is opened on the boxes the frame recorded, its rows are
//! read out of the words the frame drew, and the intent the press raises is
//! drained from the view, so a row that forks the first turn whatever was
//! pressed, or the transcript's end, turns this red.
//!
//! GAPS: which entry that turn index resolves to, and the prompt handed back
//! for it, are the desktop crate's
//! `a-fork-can-be-cut-at-a-turn-other-than-the-last.rs`; the host's own fork
//! at a named entry is `a-branch-forks-at-the-entry-the-desktop-named.test.ts`.
//! The words the same menu copies are
//! `a-turn-the-window-drew-can-be-taken-out-of-it.rs`.

use std::{path::Path, sync::Arc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Artifact, Block, Intent, Keymap, ShellState, ShellView, Turn,
	damage::Region,
	fixture, install_tokens,
	transcript::{TurnMenu, turn_menu_items},
};
use veyyon_gpui::{App, AppContext, Pixels, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The row that cuts a fork, as the menu draws it.
const BRANCH: &str = "Branch from here";
/// The row beside it, which every turn offers.
const COPY: &str = "Copy";

/// Which arm of the union a turn is, named by the turn itself so a variant
/// added to `Turn` stops this compiling.
const fn turn_kind(turn: &Turn) -> &'static str {
	match turn {
		Turn::Operator(_) => "Operator",
		Turn::OperatorArtifacts { .. } => "OperatorArtifacts",
		Turn::Agent { .. } => "Agent",
	}
}

/// Whether a turn of this kind holds a prompt, which is the only entry a fork
/// is cut at.
const fn carries_a_fork(turn: &Turn) -> bool {
	match turn {
		Turn::Operator(_) | Turn::OperatorArtifacts { .. } => true,
		Turn::Agent { .. } => false,
	}
}

/// One turn of each kind the transcript draws.
fn sample_turns() -> Vec<Turn> {
	vec![
		Turn::Operator("what does a linker do?".to_owned()),
		Turn::OperatorArtifacts {
			text:      "look at this".to_owned(),
			artifacts: vec![Artifact::Image {
				media_type: "image/png".to_owned(),
				data:       Arc::from(&[0u8, 1, 2][..]),
				alt:        Some("the composer at 960px".to_owned()),
			}],
		},
		Turn::Agent { blocks: vec![Block::Prose("it resolves symbols".to_owned())], model: None },
	]
}

/// A state holding exactly `turns`, with the panel and drawer out of the way
/// so the transcript has the window's width.
fn state_of(turns: Vec<Turn>) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = false;
	state.transcript = turns;
	state.turn_anchors.clear();
	state
}

/// Opens the window on `state` and runs `test`.
fn render_state<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	test(&mut session)
}

/// Whether the frame drew a run whose words are exactly `label`.
fn drew_label(captured: &Captured, label: &str) -> bool {
	captured
		.text_runs
		.iter()
		.any(|run| run.text.as_ref().trim() == label)
}

/// The centre of the one text run whose content is exactly `label`.
fn drawn_label(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// The centre of the box the last frame drew turn `index` in.
fn drawn_turn_centre(
	session: &mut HeadlessSession<'_, ShellView>,
	index: usize,
) -> Option<Point<Pixels>> {
	session
		.update(|view, _window, _cx| {
			view
				.laid_out()
				.drawn_bounds(Region::Turn(index))
				.map(|bounds| Point {
					x: bounds.origin.x + bounds.size.width / 2.0,
					y: bounds.origin.y + bounds.size.height / 2.0,
				})
		})
		.expect("read the boxes the frame recorded")
}

#[test]
fn the_rows_a_turn_menu_offers_are_the_rows_it_answers() {
	let forkable = TurnMenu {
		turn:     3,
		origin:   Point { x: px(0.0), y: px(0.0) },
		text:     "what does a linker do?".to_owned(),
		forkable: true,
	};
	let rows: Vec<(String, Intent)> = turn_menu_items(&forkable)
		.into_iter()
		.map(|(item, intent)| (item.label.to_string(), intent))
		.collect();
	assert_eq!(
		rows,
		vec![
			(COPY.to_owned(), Intent::CopyText("what does a linker do?".to_owned())),
			(BRANCH.to_owned(), Intent::BranchTurn(3)),
		],
		"a prompt offers its words and a fork at itself, in that order"
	);

	let answer = TurnMenu { forkable: false, ..forkable };
	let rows: Vec<String> = turn_menu_items(&answer)
		.into_iter()
		.map(|(item, _)| item.label.to_string())
		.collect();
	assert_eq!(rows, vec![COPY.to_owned()], "an answer offers its words and no fork");
}

#[test]
fn every_kind_of_turn_states_whether_it_can_carry_a_fork() {
	let turns = sample_turns();
	let kinds: Vec<&str> = turns.iter().map(turn_kind).collect();
	assert_eq!(
		kinds,
		["Operator", "OperatorArtifacts", "Agent"],
		"every arm of the turn union is swept, in the order the union states them"
	);

	let mut opened = 0usize;
	for (index, turn) in turns.iter().enumerate() {
		let wanted = carries_a_fork(turn);
		let offered = render_state(state_of(sample_turns()), |session| {
			session.frame().expect("frame renders");
			let at = drawn_turn_centre(session, index)?;
			session
				.right_click(at)
				.expect("press the turn the window drew");
			let captured = session.frame().expect("the menu renders");
			assert!(drew_label(&captured, COPY), "turn {index} offers its words");
			Some(drew_label(&captured, BRANCH))
		});

		let Some(offered) = offered else {
			continue;
		};
		assert_eq!(
			offered,
			wanted,
			"a {} turn {} the row that cuts a fork",
			turn_kind(turn),
			if wanted { "offers" } else { "does not offer" }
		);
		opened += 1;
	}
	assert_eq!(opened, 3, "every kind of turn was drawn and pressed, pressed {opened}");
}

#[test]
fn pressing_the_row_asks_to_fork_at_the_turn_it_was_opened_on() {
	let turns = sample_turns();
	let prompts: Vec<usize> = turns
		.iter()
		.enumerate()
		.filter(|(_, turn)| carries_a_fork(turn))
		.map(|(index, _)| index)
		.collect();
	assert!(prompts.len() > 1, "more than one prompt is drawn, so the wrong one can be caught");

	for index in prompts {
		let raised = render_state(state_of(sample_turns()), |session| {
			session.frame().expect("frame renders");
			let at = drawn_turn_centre(session, index)?;
			session
				.right_click(at)
				.expect("press the turn the window drew");
			let captured = session.frame().expect("the menu renders");
			let row = drawn_label(&captured, BRANCH);
			session
				.click(Point { x: px(row.x), y: px(row.y) })
				.expect("press the row the menu drew");
			let open = session
				.update(|view, _window, _cx| view.turn_menu().is_some())
				.expect("read the menu");
			assert!(!open, "the menu closes when its row is pressed, turn {index}");
			session
				.update(|view, _window, _cx| view.drain_intents())
				.ok()
		});

		let Some(raised) = raised else {
			continue;
		};
		assert_eq!(
			raised,
			vec![Intent::BranchTurn(index)],
			"the press asks to fork at turn {index} and asks for nothing else"
		);
	}
}

#[test]
fn a_window_with_no_menu_open_offers_no_fork_to_press() {
	render_state(state_of(sample_turns()), |session| {
		let captured = session.frame().expect("frame renders");
		assert!(!drew_label(&captured, BRANCH), "the row is drawn by the menu and by nothing else");
		let at = session
			.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Composer))
			.expect("read the boxes the frame recorded")
			.map(|bounds| Point {
				x: bounds.origin.x + bounds.size.width / 2.0,
				y: bounds.origin.y + bounds.size.height / 2.0,
			})
			.expect("the frame drew the composer");
		session.right_click(at).expect("press below every turn");
		let captured = session.frame().expect("frame renders");
		assert!(!drew_label(&captured, BRANCH), "a press where no turn was drawn offers no fork");
	});
}
