//! WHY: a painted rectangle that looks like a control and answers no click is
//! the worst defect this surface can ship — the operator's decision goes
//! nowhere and the window looks correct while it happens. It is also the
//! easiest defect to introduce, because a handler moves to the wrong element,
//! or the element it is on has no hit area, without changing a single pixel.
//!
//! GPUI registers a hit rect only for an element that carries a listener, a
//! hover style or another reason to be hit-tested (`should_insert_hitbox`), so
//! the frame's hit rects are exactly the set of controls the window will
//! answer. Fork patch P10 exposes them in logical pixels. These assertions
//! compare that set against the controls the state implies, counted from the
//! state and the tokens rather than from a number written here.
//!
//! `reachable` closes the other half: a control laid out past the window's edge
//! is registered, is hit-tested, and cannot be clicked. That is how a rail with
//! more rows than height fails — flex lays the overflow out below the lower
//! edge, the frame paints it clipped, and the count still matches.
//!
//! The class this closes is "a control was drawn but not wired". It does not
//! catch a control wired to the wrong intent — that is the state-side sweep in
//! `an-interaction-changes-the-state-and-reaches-the-host.rs` — and it does not
//! judge whether a hit area is comfortable, only that it exists, lies inside
//! the window and has area.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	Intent, ShellState, ShellView, fixture, install_tokens, queue::rail_fill,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// The window the shell is judged at, wide enough that the queue, the session
/// surface and the right panel are all present at once.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// Renders one state and hands back everything the frame captured.
fn capture(state: ShellState) -> Captured {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the shell renders offscreen")
}

/// How many controls a state puts on screen.
///
/// Counted from the state and the tokens through the same functions the
/// surfaces use, so the expectation moves with the rule rather than with a
/// number kept in step by hand.
fn expected_controls(state: &ShellState) -> usize {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let queue = &tokens.surface.queue;
	let cards = &tokens.surface.attached_cards;

	// Every drawn queue row is a way to open a session, and the rail draws only
	// the rows the columns row has height for: it cannot scroll, so a row laid
	// out past the window's lower edge would be painted clipped and still
	// answer a click nobody can aim. No notice is shown here, so the chrome
	// above the columns row is the titlebar alone.
	let columns_px = HEIGHT as f32 - tokens.surface.shell.titlebar_height_px;
	let rows: usize = rail_fill(&state.sections, columns_px, queue)
		.drawn
		.iter()
		.sum();
	// A tab is a control only while the panel it sits in is present.
	let tabs = if state.tree.is_empty() {
		0
	} else {
		state.tabs.len()
	};

	// A card past the stack cap is collapsed into a count and offers nothing.
	let visible_cards = cards.stack_max_visible.min(state.cards.len());
	let answers: usize = state
		.cards
		.iter()
		.take(visible_cards)
		.map(veyyon_desktop_surface::Card::answer_count)
		.sum();

	// The send control and the titlebar's drawer control are always present.
	rows + tabs + answers + 2
}

/// Whether a rect lies inside the window and encloses any area at all.
fn reachable(rect: &Bounds<Pixels>) -> bool {
	let left = f32::from(rect.origin.x);
	let top = f32::from(rect.origin.y);
	let right = f32::from(rect.right());
	let bottom = f32::from(rect.bottom());

	right > left
		&& bottom > top
		&& left >= 0.0
		&& top >= 0.0
		&& right <= WIDTH as f32
		&& bottom <= HEIGHT as f32
}

#[test]
fn the_frame_answers_a_click_on_every_control_the_state_puts_on_screen() {
	let state = fixture::populated();
	let expected = expected_controls(&state);

	let captured = capture(state);

	assert_eq!(
		captured.hitboxes.len(),
		expected,
		"the frame registered {} hit rects for {expected} controls, so a control is either unwired \
		 or one exists that nothing was drawn for",
		captured.hitboxes.len()
	);

	for rect in &captured.hitboxes {
		assert!(
			reachable(rect),
			"a control's hit rect {rect:?} falls outside the {WIDTH}x{HEIGHT} window or encloses no \
			 area, so no click can land on it"
		);
	}
}

#[test]
fn taking_the_cards_away_takes_exactly_their_answers_away() {
	let with_cards = fixture::populated();
	let answers = expected_controls(&with_cards)
		- expected_controls(&ShellState { cards: Vec::new(), ..fixture::populated() });
	assert!(answers > 0, "the fixture has no answerable card, so this proves nothing");

	let before = capture(fixture::populated()).hitboxes.len();
	let after = capture(ShellState { cards: Vec::new(), ..fixture::populated() })
		.hitboxes
		.len();

	assert_eq!(
		before - after,
		answers,
		"removing the cards changed the frame's hit rects by {} rather than the {answers} answers \
		 they offered, so a card's answers are not the controls they appear to be",
		before - after
	);
}

#[test]
fn closing_the_right_panel_takes_its_tabs_out_of_reach() {
	let open = fixture::populated();
	let tabs = open.tabs.len();
	assert!(tabs > 0, "the fixture has no tabs, so this proves nothing");

	let before = capture(fixture::populated()).hitboxes.len();
	let after = capture(ShellState { tree: Vec::new(), ..fixture::populated() })
		.hitboxes
		.len();

	assert_eq!(
		before - after,
		tabs,
		"closing the panel left {} of its {tabs} tabs answering clicks off screen",
		tabs - (before - after)
	);
}

#[test]
fn a_dispatched_intent_reaches_the_frame_the_operator_then_looks_at() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	// The drawer is the intent whose effect is a whole region rather than a
	// tint, so it is the one that proves the loop end to end: dispatch, then
	// render, then a band of the window that the session column had before.
	let closed = render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut view = ShellView::new(installed, fixture::with_drawer());
			// Closed by dispatch, from the state that ships it open, so the
			// frame below is what a click on the titlebar control produces.
			view.dispatch(Intent::SetDrawer { open: false });
			assert!(!view.state().drawer_open, "the dispatch did not close the drawer");
			view
		})
	})
	.expect("the shell renders offscreen");

	drop(cx);
	let open = capture(fixture::with_drawer());

	assert_eq!(
		closed.hitboxes.len(),
		open.hitboxes.len(),
		"the drawer changed the set of controls, and it owns none of them"
	);
	assert_ne!(
		closed.frame.as_bytes(),
		open.frame.as_bytes(),
		"a dispatched toggle produced an identical frame, so the state the shell draws from is not \
		 the state the dispatch changed"
	);
}
