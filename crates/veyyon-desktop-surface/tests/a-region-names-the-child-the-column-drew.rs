//! WHY: the session column named its children by position -- a list of region
//! names built from one set of conditions, read back against children appended
//! under another -- so a child that was added without a name shifted every name
//! after it. An error strip over the transcript, or the first-run line drawn in
//! place of a transcript, moved the whole list up by one: the transcript's box
//! was read as the cards', the cards' as the composer's, and the composer's as
//! the run bar's. Nothing about that is visible in a frame. It surfaces as a
//! press that lands on a surface nobody pressed, a float placed against the
//! wrong band, and a scroll charged to a box that is somewhere else.
//!
//! CLASS CLOSED: every shape the column's child list takes, swept as the
//! product of the conditions it branches on -- the error strip, the transcript
//! against the empty-state line, and the card stack. Each shape asserts the
//! name and the child agree in both directions: a region is recorded exactly
//! when its surface is drawn, the boxes stack in the order the column stacks
//! them, and the box a name records holds the words that surface draws.
//!
//! The last of those is what catches a shift. The composer's box must hold the
//! model name its footer states, and the run bar's the status line it states,
//! both read off the drawn frame rather than computed from a layout, so a list
//! that names the wrong child fails on the words that were painted instead of
//! on an arithmetic a later edit could restate. They are the last two names in
//! the list, so any unnamed child appended ahead of them moves both.
//!
//! NOT CAUGHT: a name recorded against the right surface at the wrong band,
//! where two adjacent children draw the same words and either box satisfies
//! the run. The drawer in its row placement is the column's sibling rather
//! than its child and is tracked from there, and the retention and reset of a
//! box after the frame that drew it is asserted by
//! `a-measured-frame-reads-only-the-boxes-it-laid-out`.
//!
//! The root above the column names its children the same way, and the ground
//! grain is a child of it: with the grain drawn first, `Titlebar` named a
//! layer the size of the window, and a float measured against that box read
//! as covering the titlebar. The last test here holds the root to the same
//! rule as the column.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Captured, Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, ShellState, ShellView, controls::ControlError, damage::Region, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// Wide enough that the rail is docked beside the session column rather than
/// collapsed over it, so the column draws every child of the shape under test
/// and none of them is shed to fit.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The action the error strip always draws, which is how the sweep tells that
/// the strip is on screen.
const STRIP_ACTION: &str = "Dismiss";

/// One shape of the column's child list.
struct Shape {
	/// Whether a control error draws the strip above the body.
	error:      bool,
	/// Whether the transcript holds turns, which decides whether the body or
	/// an empty-state line takes that position.
	transcript: bool,
	/// Whether the card stack is drawn over the composer.
	cards:      bool,
}

impl Shape {
	/// What the shape is called in a failure.
	fn label(&self) -> String {
		format!("error={} transcript={} cards={}", self.error, self.transcript, self.cards)
	}
}

/// Every shape, as the product of the conditions the column branches on. A
/// condition the column grows is a dimension here, and a name it stops
/// recording turns the sweep red rather than shrinking it.
fn shapes() -> Vec<Shape> {
	let mut shapes = Vec::new();
	for error in [false, true] {
		for transcript in [false, true] {
			for cards in [false, true] {
				shapes.push(Shape { error, transcript, cards });
			}
		}
	}
	shapes
}

/// The populated shell reduced to `shape`.
fn state_for(shape: &Shape) -> ShellState {
	let mut state = fixture::populated();
	if !shape.transcript {
		state.transcript.clear();
	}
	if !shape.cards {
		state.cards.clear();
	}
	if shape.error {
		let session = SessionId::from(state.current_id.to_string());
		state.controls.set_error(
			SurfaceId::ComposerSendButton(session),
			ControlError::new("the host refused the send", true),
		);
	}
	state
}

/// Opens the shell on `state` with the shipped keymap and editor bindings, so
/// the composer draws the footer and the caret it draws in the window rather
/// than an unbound variant of them.
fn open(cx: &mut Headless, state: ShellState) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// Opens `shape` and draws its first frame, asserting the child list it claims
/// is the one that was drawn.
///
/// The strip is the shape's only child with no name of its own, so a seeded
/// refusal the strip never states would leave half the sweep exercising the
/// same list twice under two labels -- green, and blind to the shift the strip
/// causes. `Dismiss` is the one action the strip always draws.
fn open_shape<'a>(
	cx: &'a mut Headless,
	shape: &Shape,
) -> (HeadlessSession<'a, ShellView>, Captured) {
	let mut session = open(cx, state_for(shape));
	let frame = session.frame().expect("the first frame renders");
	let drew_strip = frame
		.text_runs
		.iter()
		.any(|run| run.text.as_ref().contains(STRIP_ACTION));
	assert_eq!(
		drew_strip,
		shape.error,
		"{}: the error strip drew={drew_strip}, so the shape under test is not the shape that was \
		 drawn",
		shape.label()
	);
	(session, frame)
}

/// The box the last frame recorded for `region`.
fn box_of(session: &mut HeadlessSession<'_, ShellView>, region: Region) -> Option<Bounds<Pixels>> {
	session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
		.expect("the view is live")
}

#[test]
fn a_region_is_recorded_exactly_when_the_surface_it_names_is_drawn() {
	for shape in shapes() {
		let label = shape.label();
		let mut cx = headless_context().expect("the headless context opens");
		let (mut session, _frame) = open_shape(&mut cx, &shape);

		let recorded = session
			.update(|view, _window, _cx| view.laid_out().recorded_regions())
			.expect("the view is live");

		assert_eq!(
			recorded.contains(&Region::Transcript),
			shape.transcript,
			"{label}: the transcript is recorded when it holds turns and not when the empty-state \
			 line takes its place"
		);
		assert_eq!(
			recorded.contains(&Region::Cards),
			shape.cards,
			"{label}: the card stack is recorded when it is drawn"
		);
		assert!(
			recorded.contains(&Region::Composer),
			"{label}: the composer is drawn in every shape and is recorded in none"
		);
		assert!(
			recorded.contains(&Region::RunBar),
			"{label}: the run bar is drawn in every shape and is recorded in none"
		);
	}
}

#[test]
fn the_boxes_stack_in_the_order_the_column_stacks_its_children() {
	for shape in shapes() {
		let label = shape.label();
		let mut cx = headless_context().expect("the headless context opens");
		let (mut session, _frame) = open_shape(&mut cx, &shape);

		let composer = box_of(&mut session, Region::Composer).expect("the composer drew");
		let run_bar = box_of(&mut session, Region::RunBar).expect("the run bar drew");
		let composer_foot = f32::from(composer.origin.y + composer.size.height);
		assert!(
			f32::from(run_bar.origin.y) >= composer_foot,
			"{label}: the run bar's box starts at {}px, above the composer's foot at \
			 {composer_foot}px, so one of the two names the other's child",
			f32::from(run_bar.origin.y)
		);

		if shape.cards {
			let cards = box_of(&mut session, Region::Cards).expect("the card stack drew");
			assert!(
				f32::from(cards.origin.y + cards.size.height) <= f32::from(composer.origin.y),
				"{label}: the card stack's box does not sit above the composer's"
			);
		}
		if shape.transcript {
			let transcript = box_of(&mut session, Region::Transcript).expect("the transcript drew");
			assert!(
				f32::from(transcript.origin.y) < f32::from(composer.origin.y),
				"{label}: the transcript's box does not sit above the composer's"
			);
			assert!(
				f32::from(transcript.size.height) > 0.0,
				"{label}: the transcript's box is empty, so the name is on a child that draws nothing"
			);
		}
	}
}

/// The name the host gave the model in use, which the composer's footer states.
fn model_name(state: &ShellState) -> String {
	let control = state
		.composer
		.model
		.as_ref()
		.expect("the fixture states a model control");
	let current = control
		.current
		.as_ref()
		.expect("the fixture states a model in use");
	control
		.options
		.iter()
		.find(|option| {
			option.choice.provider == current.provider && option.choice.model == current.model
		})
		.map(|option| option.name.clone())
		.expect("the model in use is one the host offers")
}

/// Whether a run of exactly `text` was drawn within the vertical span of
/// `bounds`. The column's bands share their horizontal span, so the vertical
/// one is what tells them apart.
fn run_inside(frame: &Captured, text: &str, bounds: Bounds<Pixels>) -> bool {
	frame.text_runs.iter().any(|run| {
		run.text.as_ref() == text
			&& f32::from(run.bounds.origin.y) >= f32::from(bounds.origin.y)
			&& f32::from(run.bounds.origin.y + run.bounds.size.height)
				<= f32::from(bounds.origin.y + bounds.size.height)
	})
}

#[test]
fn the_box_a_region_names_holds_the_words_that_surface_draws() {
	for shape in shapes() {
		let label = shape.label();
		let state = state_for(&shape);
		let status = state
			.run_status
			.as_ref()
			.expect("the fixture states a run status")
			.1
			.clone();
		let model = model_name(&state);

		let mut cx = headless_context().expect("the headless context opens");
		let (mut session, frame) = open_shape(&mut cx, &shape);
		let composer = box_of(&mut session, Region::Composer).expect("the composer drew");
		let run_bar = box_of(&mut session, Region::RunBar).expect("the run bar drew");

		// The last two names in the list, so a child appended ahead of them
		// without a name of its own moves both off the surfaces they name.
		assert!(
			run_inside(&frame, &model, composer),
			"{label}: the box recorded for the composer does not hold the model name its footer \
			 states ({model}), so the name is on another child"
		);
		assert!(
			run_inside(&frame, &status, run_bar),
			"{label}: the box recorded for the run bar does not hold the status line it states, so \
			 the name is on another child"
		);
	}
}

#[test]
fn the_titlebar_box_is_the_titlebar_and_not_the_layer_under_it() {
	// The root's own child list: the ground grain draws before the titlebar
	// and takes the whole window, so a name read off a position rather than
	// off the child names the grain. The box is measured against the height
	// the tokens declare for the titlebar, which a full-window layer fails by
	// the height of the window.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let declared = tokens.surface.shell.titlebar_height_px;
	assert!(
		tokens.surface.shell.grain_opacity > 0.0 && tokens.surface.shell.grain_tile_px > 0.0,
		"the bundled tokens draw no ground grain, so the root has one child and this proves nothing"
	);

	for shape in shapes() {
		let label = shape.label();
		let state = state_for(&shape);
		let title = state.title.clone();
		let mut cx = headless_context().expect("the headless context opens");
		let (mut session, frame) = open_shape(&mut cx, &shape);
		let titlebar = box_of(&mut session, Region::Titlebar).expect("the titlebar drew");

		assert!(
			(f32::from(titlebar.size.height) - declared).abs() <= 1.0,
			"{label}: the box recorded for the titlebar is {:.1}px tall against the {declared:.1}px \
			 the tokens declare, so the name is on another child of the root",
			f32::from(titlebar.size.height)
		);
		assert!(
			run_inside(&frame, &title, titlebar),
			"{label}: the box recorded for the titlebar does not hold the session title it states \
			 ({title}), so the name is on another child of the root"
		);
	}
}
