//! The thread header's freeze control: Pause while agents run, Resume once
//! the host states them frozen, once until the host answers, and neither
//! while the host withholds the lifecycle.
//!
//! WHY: the freeze is the host's, held for every agent in its process. A
//! control that flipped on its own press would offer Resume in the window
//! that pressed and Pause in every other for one freeze; one read off the
//! host's statement flips in every window at once, including one that never
//! pressed. A press sent again while the first is in flight asks the host
//! twice for one freeze. A control live while the host withholds the
//! lifecycle sends a request the host refuses.
//!
//! Gap: the icon and the tooltip are not read; the request each press sends
//! is. The strip that states the freeze is the workspace suite's. The same
//! control rule for the header's other buttons is the header suite's.

use gpui::TestAppContext;
use veyyon_desktop_model::{AgentPauseView, Capability, HostAction, HostEvent, SnapshotSection};

use super::{Win, capability, window};

/// The host stating every agent frozen since `since_ms`.
const fn frozen(since_ms: u64) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::AgentPause(AgentPauseView {
		paused:   true,
		since_ms: Some(since_ms),
	}))
}

/// The host stating its agents running.
const fn running() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::AgentPause(AgentPauseView::RUNNING))
}

/// Presses the control, answers every request it sent, and returns them.
fn press(w: &mut Win<'_>) -> Vec<HostAction> {
	w.click("thread.pause");
	let requests = w.requests();
	w.apply(
		requests
			.iter()
			.map(|request| HostEvent::RequestSucceeded { request: request.id })
			.collect(),
	);
	requests.into_iter().map(|request| request.action).collect()
}

#[gpui::test]
fn the_control_follows_the_freeze_the_host_states_not_its_own_press(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	w.click("thread.pause");
	let pressed = w.requests();
	assert_eq!(
		pressed
			.iter()
			.map(|request| &request.action)
			.collect::<Vec<_>>(),
		vec![&HostAction::PauseAgents]
	);
	w.click("thread.pause");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a press in flight is not sent again");
	w.apply(vec![HostEvent::RequestSucceeded { request: pressed[0].id }]);
	assert_eq!(
		press(&mut w),
		vec![HostAction::PauseAgents],
		"an answered press leaves the control on Pause"
	);

	w.apply(vec![frozen(1_000)]);
	assert_eq!(press(&mut w), vec![HostAction::ResumeAgents], "a stated freeze offers its release");

	w.apply(vec![running()]);
	assert_eq!(press(&mut w), vec![HostAction::PauseAgents], "a released freeze offers Pause again");
}

#[gpui::test]
fn a_withheld_lifecycle_leaves_the_control_sending_nothing(app: &mut TestAppContext) {
	let mut w =
		window(app, vec![capability(Capability::Lifecycle, Some("this host runs no agents"))]);
	w.click("thread.pause");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "Pause is held back");

	w.apply(vec![frozen(1_000)]);
	w.click("thread.pause");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "and so is Resume");

	w.apply(vec![capability(Capability::Lifecycle, None)]);
	w.click("thread.pause");
	assert_eq!(w.sent(), vec![HostAction::ResumeAgents], "a granted lifecycle takes the press");
}
