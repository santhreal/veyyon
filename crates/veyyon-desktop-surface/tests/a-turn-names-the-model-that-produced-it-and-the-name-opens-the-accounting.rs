//! WHY: `EntryMeta.usage` has seven fields, and a turn header carrying them
//! makes every turn open with a row of figures nobody reads twice. The turn
//! footer names the model instead and is the only route to those figures, so
//! two defects are one wiring away from each other: a footer drawn for a turn
//! whose model the host never reported, and a footer that names a model and
//! answers no click, leaving the accounting unreachable from the transcript.
//!
//! CLASS CLOSED:
//! 1. A footer drawn for the wrong turn shape. Every `Turn` variant is swept
//!    from an exhaustive match, so a new variant fails to compile here until it
//!    states whether it carries a footer.
//! 2. A turn whose model the host did not report drawing a footer anyway, which
//!    would name nothing.
//! 3. The footer drawn above the blocks rather than under them, which would
//!    read as another block of the turn.
//! 4. The footer answering no click: the frame's hit rects are asserted to
//!    include the row the name is drawn in.
//! 5. The click reaching the shell as some other intent, or as none.
//! 6. The click landing on a tab the panel does not list, which would open an
//!    empty panel: the intent is applied to a panel that starts without the
//!    usage tab and the tab is asserted to be there afterwards.
//! 7. A name only a pointer can read. The captured raster is counted inside the
//!    name's own box with the turn at rest and with the keyboard's cursor on
//!    it, so a reveal wired to hover alone fails here.
//!
//! NOT CAUGHT: the model name's text. A captured frame carries each shaped
//! run's box and size, not its string, so this suite reads the run's size and
//! position. Nor does it catch the pointer hover itself: `group_hover` resolves
//! against a real pointer position, which an offscreen frame has none of, so
//! the hover arm is what the native capture in `proof/scenes/` records.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession, RgbaFrame,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Block, Intent, PanelContent, PanelTab, ShellState, ShellView, Turn, attach::ConnectionPhase,
	install_tokens,
};
use veyyon_desktop_tokens::TypeSizeStep;
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, TextRunLayout};

/// The model the fixture turns name.
const MODEL: &str = "claude-sonnet-4-6";

/// Whether a turn of this shape carries a footer naming its model.
///
/// Matched exhaustively: a new turn variant is a compile error here rather than
/// a shape nobody decided about.
const fn carries_a_footer(turn: &Turn) -> bool {
	match turn {
		Turn::Operator(_) | Turn::OperatorArtifacts { .. } => false,
		Turn::Agent { model, .. } => model.is_some(),
	}
}

/// One paragraph, long enough to shape a run and short enough to stay on one
/// line of the column.
fn prose() -> String {
	"Six tests passed and none failed.".to_owned()
}

/// Every turn shape, each in the state the footer rule distinguishes.
fn every_turn_shape() -> Vec<Turn> {
	vec![
		Turn::Operator("run the tests".to_owned()),
		Turn::OperatorArtifacts { text: "and this file".to_owned(), artifacts: Vec::new() },
		Turn::Agent { blocks: vec![Block::Prose(prose())], model: None },
		Turn::Agent { blocks: vec![Block::Prose(prose())], model: Some(MODEL.to_owned()) },
	]
}

/// A shell showing exactly one transcript turn: no queue, no panel, no cards,
/// so the runs and hit rects the transcript column produces are the turn's own.
fn state_with(turn: Turn) -> ShellState {
	ShellState {
		title: "usage".to_owned(),
		transcript: vec![turn],
		connection: ConnectionPhase::Attached,
		panel: PanelContent::default(),
		..ShellState::default()
	}
}

fn open(cx: &mut Headless, state: ShellState) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	HeadlessSession::open(
		cx,
		&RenderOptions { width: 1280, height: 800, scale_factor: 1.0, ..RenderOptions::default() },
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, state))
		},
	)
	.expect("the session opens offscreen")
}

/// Where the turn's body was drawn. Every footer assertion is relative to it.
struct Column {
	left:         f32,
	right:        f32,
	prose_bottom: f32,
	prose_size:   f32,
}

/// Locates the body run of the turn: the widest run at the assistant turn's
/// type size.
fn column_of(runs: &[TextRunLayout], body_size: f32) -> Option<Column> {
	let prose = runs
		.iter()
		.filter(|run| (f32::from(run.font_size) - body_size).abs() < 0.5)
		.max_by(|left, right| {
			f32::from(left.bounds.size.width).total_cmp(&f32::from(right.bounds.size.width))
		})?;
	Some(Column {
		left:         f32::from(prose.bounds.left()) - 8.0,
		right:        f32::from(prose.bounds.right()) + 8.0,
		prose_bottom: f32::from(prose.bounds.bottom()),
		prose_size:   f32::from(prose.font_size),
	})
}

/// The runs the footer drew: every run at the footer's size, inside the
/// column's measure, below the body.
fn footer_runs(runs: &[TextRunLayout], column: &Column, footer_size: f32) -> Vec<Bounds<Pixels>> {
	runs
		.iter()
		.filter(|run| (f32::from(run.font_size) - footer_size).abs() < 0.5)
		.filter(|run| {
			let left = f32::from(run.bounds.left());
			left >= column.left && left <= column.right
		})
		.filter(|run| f32::from(run.bounds.top()) >= column.prose_bottom)
		.map(|run| run.bounds)
		.collect()
}

fn center_of(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}

/// The footer's type size and the body's, from the bundled tokens.
fn sizes() -> (f32, f32) {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	(
		bundled.scale.type_size(TypeSizeStep::Small).size,
		bundled.surface.transcript.assistant_turn_type_size.size,
	)
}

#[test]
fn only_a_turn_whose_model_the_host_reported_draws_a_footer() {
	let (footer_size, body_size) = sizes();
	let mut cx = headless_context().expect("a headless renderer is required");

	for turn in every_turn_shape() {
		let expected = carries_a_footer(&turn);
		let shape = format!("{turn:?}");
		let mut session = open(&mut cx, state_with(turn));
		let frame = session.frame().expect("the turn renders");

		let Some(column) = column_of(&frame.text_runs, body_size) else {
			assert!(
				!expected,
				"the turn {shape} drew no body run to place a footer against, so the footer this \
				 shape is supposed to carry could not have been drawn"
			);
			continue;
		};
		let footers = footer_runs(&frame.text_runs, &column, footer_size);

		assert_eq!(
			footers.len(),
			usize::from(expected),
			"the turn {shape} drew {} footer runs under its body and {} were expected: a footer \
			 belongs to an agent turn whose model the host reported and to no other shape",
			footers.len(),
			usize::from(expected)
		);

		if !expected {
			continue;
		}
		let footer = footers[0];
		assert!(
			(column.prose_size - footer_size).abs() > 0.5,
			"the footer and the body are the same size, so this suite cannot tell one from the other \
			 and proves nothing about either"
		);
		assert!(
			f32::from(footer.top()) >= column.prose_bottom,
			"the footer at {footer:?} is drawn at or above the body it names, which reads as another \
			 block of the turn rather than the turn's last row"
		);
		assert!(
			frame.hitboxes.iter().any(|rect| {
				rect.contains(&center_of(footer))
					&& f32::from(rect.size.height) <= f32::from(footer.size.height) * 3.0
			}),
			"the footer at {footer:?} names the model and no hit rect of its own size covers it, so \
			 the click that opens the accounting lands on nothing"
		);
	}
}

#[test]
fn clicking_the_name_opens_the_accounting_on_a_tab_the_panel_lists() {
	let (footer_size, body_size) = sizes();
	let mut cx = headless_context().expect("a headless renderer is required");

	// The host lists the usage tab from the capability, which it may not have
	// answered yet when the operator clicks the name, and the panel starts
	// collapsed as it does on a fresh window.
	let turn = Turn::Agent { blocks: vec![Block::Prose(prose())], model: Some(MODEL.to_owned()) };
	let mut state = state_with(turn);
	state.panel.tabs = vec![PanelTab::Diff];
	state.panel.active_tab = PanelTab::Diff;
	state.keymap.panel_collapsed = true;

	let mut session = open(&mut cx, state);
	let frame = session.frame().expect("the turn renders");
	let column = column_of(&frame.text_runs, body_size).expect("the turn drew its body");
	let footers = footer_runs(&frame.text_runs, &column, footer_size);
	assert_eq!(footers.len(), 1, "the turn drew {} footer runs, not one", footers.len());

	session
		.update(|view, _window, _cx| {
			let _ = view.drain_intents();
		})
		.expect("the recorded intents drain");
	session
		.click(center_of(footers[0]))
		.expect("the click on the model name is delivered");

	let (dispatched, tabs, active, collapsed) = session
		.update(|view, _window, _cx| {
			let dispatched = view.drain_intents();
			let state = view.state();
			(
				dispatched,
				state.panel.tabs.clone(),
				state.panel.active_tab,
				state.keymap.panel_collapsed,
			)
		})
		.expect("the shell reports what the click did");

	assert_eq!(
		dispatched,
		vec![Intent::OpenUsage],
		"a click on the model name dispatched {dispatched:?}: the name's one job is to open the \
		 accounting, so it dispatches OpenUsage and nothing else"
	);
	assert!(
		tabs.contains(&PanelTab::Usage),
		"the panel lists {tabs:?} after the name was clicked: the tab the click selects has to be \
		 one the strip offers, or the operator lands on a panel with no way back to it"
	);
	assert_eq!(active, PanelTab::Usage, "the click selected {active:?} instead of the usage tab");
	assert!(
		!collapsed,
		"the panel stayed collapsed, so the accounting the click opened is not on screen"
	);
}

/// Ink drawn inside `box_` of the captured raster: pixels brighter than the
/// ground the transcript draws on.
///
/// The reveal is an opacity refinement, which no layout box or shaped run
/// records, so the pixels are what states whether the name is legible.
fn ink_in(frame: &RgbaFrame, box_: Bounds<Pixels>) -> usize {
	let left = f32::from(box_.left()).max(0.0) as u32;
	let top = f32::from(box_.top()).max(0.0) as u32;
	let right = f32::from(box_.right()).max(0.0) as u32;
	let bottom = f32::from(box_.bottom()).max(0.0) as u32;
	let mut lit = 0;
	for y in top..bottom.min(frame.height()) {
		for x in left..right.min(frame.width()) {
			if frame
				.pixel(x, y)
				.is_some_and(|pixel| pixel.luma_255() > 40.0)
			{
				lit += 1;
			}
		}
	}
	lit
}

#[test]
fn the_keyboard_reveals_the_name_the_pointer_reveals_on_hover() {
	let (footer_size, body_size) = sizes();
	let mut cx = headless_context().expect("a headless renderer is required");

	let turn = Turn::Agent { blocks: vec![Block::Prose(prose())], model: Some(MODEL.to_owned()) };
	let mut session = open(&mut cx, state_with(turn));
	let resting = session.frame().expect("the turn renders");
	let column = column_of(&resting.text_runs, body_size).expect("the turn drew its body");
	let footers = footer_runs(&resting.text_runs, &column, footer_size);
	assert_eq!(footers.len(), 1, "the turn drew {} footer runs, not one", footers.len());
	let name = footers[0];

	let at_rest = ink_in(&resting.frame, name);
	assert_eq!(
		at_rest, 0,
		"the model name inked {at_rest} pixels with no pointer over the turn and no keyboard on it: \
		 the footer is a reveal, so a turn nobody is looking at states nothing"
	);

	// The keyboard's turn cursor, as `PreviousTurn` moves it onto the turn on
	// screen.
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::StepTurn(-1), cx);
		})
		.expect("the turn step is dispatched");
	let focused = session.frame().expect("the focused turn renders");
	let revealed = ink_in(&focused.frame, name);

	assert!(
		revealed > 0,
		"the model name inked nothing with the keyboard on its turn: an operator who is not holding \
		 a pointer cannot read which model answered, and the accounting the name leads to is \
		 unreachable for them"
	);
}

#[test]
fn the_turn_cursor_stops_on_the_last_turn_however_far_it_is_stepped() {
	let mut cx = headless_context().expect("a headless renderer is required");

	let turn = Turn::Agent { blocks: vec![Block::Prose(prose())], model: Some(MODEL.to_owned()) };
	let mut session = open(&mut cx, state_with(turn));

	let focused = session
		.update(|view, _window, cx| {
			for _ in 0..6 {
				view.dispatch(Intent::StepTurn(1), cx);
			}
			view.state().keymap.focused_turn
		})
		.expect("the turn steps are dispatched");

	assert_eq!(
		focused,
		Some(0),
		"stepping down six times in a one-turn transcript left the cursor on {focused:?}: a cursor \
		 parked past the last turn names no model and discloses no card, so every later keystroke \
		 is dropped in silence"
	);
}
