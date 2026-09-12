//! WHY: a block still arriving is drawn in two pieces, and only the settled
//! piece carries spans. A drag into the arriving piece would name text whose
//! shape changes with the next delta, so it offers nothing to take.
//!
//! CLASS CLOSED: the arriving piece of a streaming block is offered to the
//! selection. The live window is where the boundary decides which piece
//! carries the spans, so this drives the real shell rather than a frame.
//!
//! NOT CAUGHT: the settled piece's own span numbering, which the seam test in
//! `a-reply-still-arriving-draws-the-shape-it-is-becoming.rs` pins at every
//! split point.

use veyyon_desktop_surface::{
	composer::{QueueMode, TurnPhase},
	model::{Block, Turn},
};

#[path = "support/text-selection/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared selection helpers")]
mod harness;

use harness::{along, render_session, run_holding};

/// The paragraph that has settled in the turn the drag case opens on.
const SETTLED: &str = "The first paragraph settled and cannot change.";

/// The turn the drag case opens on: one settled paragraph, then a block still
/// arriving with an emphasis open in it.
fn arriving_turn() -> Vec<Turn> {
	vec![Turn::Agent {
		blocks: vec![Block::Prose(format!("{SETTLED}\n\nand then **word"))],
		model:  None,
	}]
}

/// A drag takes the settled words, and the arriving block offers nothing to
/// take: its shape changes with the next delta, so a selection into it would
/// name text that is about to be something else.
#[test]
fn a_drag_takes_the_settled_words_and_the_arriving_block_offers_none() {
	let (settled, arriving) = render_session(arriving_turn(), |session| {
		session
			.update(|view, _window, _cx| {
				view.state_mut().turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
			})
			.expect("the turn is running");
		let frame = session.frame().expect("frame renders while the turn runs");
		let first = run_holding(&frame, "settled and cannot");
		session
			.drag(along(first, 0.2), along(first, 0.9))
			.expect("the drag crosses the settled paragraph");
		let settled = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		let frame = session.frame().expect("frame renders after the drag");
		let word = run_holding(&frame, "word");
		session
			.drag(along(word, 0.1), along(word, 0.9))
			.expect("the drag crosses the arriving block");
		let arriving = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		(settled, arriving)
	});
	assert!(
		!settled.is_empty() && SETTLED.contains(settled.trim()),
		"the settled paragraph is what the drag took, took {settled:?}"
	);
	assert!(
		arriving.is_empty(),
		"the arriving block offers no span to drag over, took {arriving:?}"
	);
}
