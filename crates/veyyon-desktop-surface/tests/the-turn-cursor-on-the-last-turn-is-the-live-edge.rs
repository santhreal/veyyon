//! WHY: stepping the turn cursor revealed the focused turn as an ordinary row,
//! which stops the viewport following the tail. Stepping onto the LAST turn
//! then raised the "Scroll to end" pill over a transcript already showing its
//! end, so the pill offered a jump to where the operator was standing and the
//! next streamed turn arrived off screen.
//!
//! CLASS CLOSED: the cursor and the live edge disagreeing. Both directions are
//! swept: a step onto the last turn keeps following the tail, and a step onto
//! an earlier turn stops following it, since a cursor that always followed
//! would drag the operator back to the end whenever they walked up the
//! transcript.
//!
//! NOT CAUGHT: whether the pill is drawn from `is_following_tail`; that wiring
//! is asserted in `the-transcript-viewport-anchors-scrolls-and-expands.rs`.
//! Nor the scroll animation's shape, which is the motion suite's.

use std::{path::Path, time::Duration};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Block, Intent, ShellState, ShellView, Turn, attach::ConnectionPhase, install_tokens,
};
use veyyon_gpui::{App, AppContext};

/// Enough turns that the column overflows an 800px window, so following the
/// tail is a state the viewport can actually leave.
const TURNS: usize = 24;

fn state() -> ShellState {
	let mut transcript = Vec::with_capacity(TURNS * 2);
	for index in 0..TURNS {
		transcript.push(Turn::Operator(format!("run the tests, take {index}")));
		transcript.push(Turn::Agent {
			blocks: vec![Block::Prose(format!("Take {index}: six tests passed and none failed."))],
			model:  Some("claude-sonnet-4-6".to_owned()),
		});
	}
	ShellState {
		title: "live edge".to_owned(),
		transcript,
		connection: ConnectionPhase::Attached,
		..ShellState::default()
	}
}

fn open(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	HeadlessSession::open(
		cx,
		&RenderOptions { width: 1280, height: 800, scale_factor: 1.0, ..RenderOptions::default() },
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, state()))
		},
	)
	.expect("the session opens offscreen")
}

/// Steps the cursor `presses` times in `delta`'s direction and settles the
/// scroll transition the step started.
fn step(session: &mut HeadlessSession<'_, ShellView>, delta: i32, presses: usize) -> bool {
	session
		.update(|view, _window, cx| {
			for _ in 0..presses {
				view.dispatch(Intent::StepTurn(delta), cx);
			}
		})
		.expect("the turn steps are dispatched");
	session.frame().expect("the stepped transcript renders");
	// The jump is a transition, and following the tail resumes when it settles.
	session.advance(Duration::from_millis(1_200));
	session.frame().expect("the settled transcript renders");
	session
		.update(|view, _window, _cx| view.transcript_viewport().is_following_tail())
		.expect("the viewport reports whether it is following the tail")
}

#[test]
fn stepping_onto_the_last_turn_keeps_the_transcript_at_its_end() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open(&mut cx);

	// Twice the turn count, so the cursor is on the last turn however the
	// clamp counts.
	let following = step(&mut session, 1, TURNS * 4);

	assert!(
		following,
		"the transcript stopped following the tail with the cursor on its last turn: the \"Scroll \
		 to end\" pill then covers the turn it offers to scroll to, and the next streamed turn \
		 arrives off screen"
	);
}

#[test]
fn stepping_onto_an_earlier_turn_leaves_the_live_edge() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open(&mut cx);

	// With no cursor yet, a step up lands on the first turn, which is as far
	// from the tail as this transcript goes.
	let following = step(&mut session, -1, 1);

	assert!(
		!following,
		"the transcript kept following the tail with the cursor on its first turn, so the next \
		 streamed turn drags the operator back down from the turn they were reading"
	);
}
