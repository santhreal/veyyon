//! The primary control in every phase of a turn: what the session waits on,
//! whether a turn runs, whether the draft holds text and the queue mode.
//!
//! WHY: the control reads four inputs, and a slip in their precedence sends
//! the wrong request. A running turn read before a pending decision steers
//! the turn with the answer to a question; a draft read under an approval
//! makes Enter approve it; a queue mode read while the turn is idle queues a
//! prompt behind nothing; a dialog read as a question sends the draft as its
//! answer. The sweep crosses each decision kind the session can wait on with
//! an idle and a running turn, an empty and a written draft and every queue
//! mode, reads the control the composer settled on, and requires every
//! control to be reached. A new decision kind fails to compile in `only`, and
//! a new control fails to compile in `slot`, until the sweep places it.
//!
//! Gap: one decision at a time; the order among several is the dock's and is
//! covered in `dock`. What each control sends is covered in `composer`,
//! `dock` and `gates`; the control's glyph and fill are not read.

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{actions::composer::ToggleQueueMode, composer::Primary};
use veyyon_desktop_model::{HostEvent, PendingDecisions, QueueMode};

use super::{
	Win,
	dock::{approval, dialog, only, plan, question},
	streamed, waiting, window,
};

/// What the session waits on.
#[derive(Clone, Copy, Debug, strum::EnumIter)]
enum Waits {
	Nothing,
	Question,
	Approval,
	Plan,
	Dialog,
}

impl Waits {
	fn pending(self) -> PendingDecisions {
		match self {
			Self::Nothing => PendingDecisions::new(),
			Self::Question => only(
				Vec::new(),
				vec![question("q1", "Which branch?", &["main", "dev"], 1)],
				Vec::new(),
				Vec::new(),
			),
			Self::Approval => {
				only(vec![approval("a1", "bash", 1)], Vec::new(), Vec::new(), Vec::new())
			},
			Self::Plan => only(Vec::new(), Vec::new(), vec![plan("p1", 1)], Vec::new()),
			Self::Dialog => only(Vec::new(), Vec::new(), Vec::new(), vec![dialog("d1", 1)]),
		}
	}
}

/// How many controls there are.
const CONTROLS: usize = 8;

/// The control's place in the tally of controls reached.
const fn slot(primary: Primary) -> usize {
	match primary {
		Primary::Send => 0,
		Primary::Steer => 1,
		Primary::Queue => 2,
		Primary::Stop => 3,
		Primary::Answer => 4,
		Primary::Approve => 5,
		Primary::Accept => 6,
		Primary::Refine => 7,
	}
}

/// The control a phase offers: a question takes the draft as its answer, an
/// approval answers from its button, a plan is refined by a written draft
/// and accepted without one. A dialog is answered in the dock, so the turn
/// decides: an idle one sends, a running one stops on an empty draft and
/// steers or queues a written one.
const fn expected(waits: Waits, running: bool, written: bool, mode: QueueMode) -> Primary {
	match (waits, running, written, mode) {
		(Waits::Question, ..) => Primary::Answer,
		(Waits::Approval, ..) => Primary::Approve,
		(Waits::Plan, _, true, _) => Primary::Refine,
		(Waits::Plan, _, false, _) => Primary::Accept,
		(Waits::Nothing | Waits::Dialog, false, ..) => Primary::Send,
		(Waits::Nothing | Waits::Dialog, true, false, _) => Primary::Stop,
		(Waits::Nothing | Waits::Dialog, true, true, QueueMode::Steer) => Primary::Steer,
		(Waits::Nothing | Waits::Dialog, true, true, QueueMode::Queue) => Primary::Queue,
	}
}

fn queue_mode(w: &Win<'_>) -> QueueMode {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.queue_mode())
}

/// Puts the session in the phase, the turn's stream at `revision`.
fn enter(w: &mut Win<'_>, phase: (Waits, bool, bool, QueueMode), revision: u64) {
	let (waits, running, written, mode) = phase;
	let stream = if running {
		streamed(revision)
	} else {
		HostEvent::StreamingChanged(None)
	};
	w.apply(vec![waiting(waits.pending()), stream]);
	w.write(if written { "Skip vendor." } else { "" });
	if queue_mode(w) != mode {
		w.dispatch(ToggleQueueMode);
	}
	assert_eq!(queue_mode(w), mode, "the chord put the draft in {mode:?}");
	w.drain();
}

#[gpui::test]
fn every_phase_of_a_turn_offers_the_one_control_it_takes(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	let mut reached = [false; CONTROLS];
	let mut wrong = Vec::new();
	let mut revision = 1;
	for waits in Waits::iter() {
		for running in [false, true] {
			for written in [false, true] {
				for mode in QueueMode::iter() {
					revision += 1;
					let phase = (waits, running, written, mode);
					enter(&mut w, phase, revision);
					let primary = w
						.composer
						.read_with(&*w.cx, |composer, _| composer.primary_action());
					reached[slot(primary)] = true;
					let want = expected(waits, running, written, mode);
					if primary != want {
						wrong.push(format!("{phase:?}: {primary:?}, expected {want:?}"));
					}
				}
			}
		}
	}
	assert_eq!(wrong, Vec::<String>::new(), "(waits, running, written, mode)");
	assert_eq!(reached, [true; CONTROLS], "every control is offered in some phase");
}
