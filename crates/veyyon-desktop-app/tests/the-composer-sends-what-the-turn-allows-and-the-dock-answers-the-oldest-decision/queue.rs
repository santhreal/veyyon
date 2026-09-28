//! The queue mode and the queued prompts: the mode the chord picks stays
//! through the host's next frames and the session's next visit, the chord
//! changes nothing while the host cannot queue or takes no queue mode, and a
//! take-back asks for a queued prompt and puts the answer in the draft of
//! the session it came from.
//!
//! WHY: the mode is the window's, not the host's: a frame that derived it
//! again from host state took the chord's choice back within a frame of the
//! keypress. A chord that reads no gate flips a mode the disabled chip states
//! cannot change. A take-back answer is one frame's text: landing it in the
//! draft on screen when it was for another session overwrites what is typed
//! there, and keeping it lands it again on every later queue report.
//!
//! Gap: the host acting on the mode (a queued prompt delivered after the
//! turn) is the host's contract. Take-back is driven by its action; the
//! strip's button is not clicked.

use gpui::TestAppContext;
use veyyon_desktop_app::actions::composer::{TakeBackQueued, ToggleQueueMode};
use veyyon_desktop_model::{
	Capability, HostAction, HostActionKind, HostEvent, PendingDecisions, QueueMode,
	QueuedPromptsView, SessionId, SnapshotSection, action_to_capability,
};

use super::{Win, capability, header, other, sid, streamed, waiting, window};

fn queue_mode(w: &Win<'_>) -> QueueMode {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.queue_mode())
}

/// The prompts `session` holds, and the one a take-back handed back.
fn queued(
	session: SessionId,
	steering: &[&str],
	follow_up: &[&str],
	restored: Option<&str>,
) -> HostEvent {
	let owned = |prompts: &[&str]| prompts.iter().map(|prompt| (*prompt).to_owned()).collect();
	HostEvent::Snapshot(SnapshotSection::QueuedPrompts(QueuedPromptsView {
		session,
		steering: owned(steering),
		follow_up: owned(follow_up),
		restored: restored.map(str::to_owned),
	}))
}

/// Where each of `texts` is drawn among the last frame's text runs.
fn drawn_at(w: &mut Win<'_>, texts: &[&str]) -> Vec<Option<usize>> {
	w.cx.update(|window, _| {
		let runs = window.rendered_text_runs();
		texts
			.iter()
			.map(|text| runs.iter().position(|run| run.text.as_ref() == *text))
			.collect()
	})
}

#[gpui::test]
fn the_mode_the_chord_picks_survives_the_hosts_frames_and_a_visit_to_another_thread(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![streamed(2)]);
	assert!(w.drew("Steer"), "a running turn states its queue mode");
	w.focus();
	w.keys("alt-q");
	assert_eq!(w.sent(), vec![HostAction::SetQueueMode {
		session: sid(),
		mode:    QueueMode::Queue,
	}]);
	assert_eq!(queue_mode(&w), QueueMode::Queue);

	w.apply(vec![
		streamed(3),
		header(None, 2),
		capability(Capability::TurnControl, None),
		waiting(PendingDecisions::new()),
	]);
	assert_eq!(queue_mode(&w), QueueMode::Queue, "the host's frames left the chord's mode");
	assert!(w.drew("Queue") && !w.drew("Steer"), "the chip states the mode the chord picked");

	w.show(other());
	assert_eq!(queue_mode(&w), QueueMode::Steer, "another thread keeps its own mode");
	w.show(sid());
	assert_eq!(queue_mode(&w), QueueMode::Queue, "the thread gets back the mode it was left in");
}

#[test]
fn the_chord_changes_nothing_while_the_host_cannot_queue_or_takes_no_queue_mode() {
	let refusals =
		[action_to_capability(HostActionKind::SetQueueMode), Capability::BackgroundSubmission];
	for refused in refusals {
		let mut app = TestAppContext::single();
		let mut w =
			window(&mut app, vec![streamed(2), capability(refused, Some("the host steers only"))]);
		w.focus();
		w.keys("alt-q");
		assert_eq!(
			queue_mode(&w),
			QueueMode::Steer,
			"{refused:?} refused: the chord leaves the mode"
		);
		w.dispatch(ToggleQueueMode);
		assert_eq!(
			queue_mode(&w),
			QueueMode::Steer,
			"{refused:?} refused: the action leaves the mode"
		);
		assert_eq!(w.sent(), Vec::new(), "{refused:?} refused: nothing is sent");
		assert_eq!(w.saved(&sid()), None, "{refused:?} refused: no mode is saved");
	}
}

#[gpui::test]
fn a_take_back_asks_for_a_queued_prompt_and_its_answer_lands_once_before_the_draft(
	app: &mut TestAppContext,
) {
	let mut w = window(app, vec![streamed(2)]);
	let held = ["Skip vendor.", "Stop at the first failure.", "Then run the tests."];
	w.apply(vec![queued(sid(), &held[..2], &held[2..], None)]);
	assert!(w.drew("3 queued"));
	let at = drawn_at(&mut w, &held);
	assert!(
		at.iter().all(Option::is_some) && at.is_sorted(),
		"the strip draws steering then follow-up, oldest first: {at:?}"
	);

	w.write("Also lint.");
	w.dispatch(TakeBackQueued);
	assert_eq!(w.sent(), vec![HostAction::DequeueQueuedPrompt { session: sid() }]);

	w.apply(vec![queued(sid(), &held[..1], &held[2..], None)]);
	assert_eq!(w.draft(), "Also lint.", "a queue report that answers nothing leaves the draft");
	w.apply(vec![queued(sid(), &held[..1], &held[2..], Some(held[1]))]);
	assert_eq!(w.draft(), "Stop at the first failure.\n\nAlso lint.");
	w.apply(vec![queued(sid(), &held[..1], &held[2..], None)]);
	assert_eq!(
		w.draft(),
		"Stop at the first failure.\n\nAlso lint.",
		"the answer lands once, not on the next report"
	);
}

#[gpui::test]
fn a_take_back_answered_for_another_thread_waits_in_that_threads_draft(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	w.write("Half a prompt");
	w.apply(vec![queued(other(), &[], &[], Some("Taken back in t"))]);
	assert_eq!(w.draft(), "Half a prompt", "the answer is not for the draft on screen");
	w.show(other());
	assert_eq!(w.draft(), "Taken back in t");
	w.show(sid());
	assert_eq!(w.draft(), "Half a prompt");
}
