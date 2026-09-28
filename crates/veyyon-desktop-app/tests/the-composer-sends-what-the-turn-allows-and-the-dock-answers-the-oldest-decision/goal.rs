//! The goal the dock pins over the composer: each status drawn with its own
//! words and only the controls it allows, the goal set from the draft, and
//! every goal request held back while the host withholds goals.
//!
//! WHY: a status drawn in another's words tells the operator the run is
//! going when it has stood down. A control its status does not allow, such
//! as Pause on a paused goal or Resume on an active one, sends a request the
//! host refuses, and a missing one leaves a budget-limited run with no way
//! on. A goal set that clears a draft the host never took loses the
//! objective, and a control live while the host withholds goals sends
//! refused requests. The sweeps read `GoalStatus` and `GoalControl` at run
//! time and each member's words and controls are an exhaustive match, so a
//! new member fails to compile here until its row is written.
//!
//! Gap: the status dot and the controls' ink are not read, and the buttons
//! are not clicked; the keys bound to each control are pressed instead.

use gpui::TestAppContext;
use strum::IntoEnumIterator;
use veyyon_desktop_app::actions::{
	composer::SetGoalFromDraft,
	dock::{DropGoal, PauseGoal, ResumeGoal},
};
use veyyon_desktop_model::{
	Capability, GoalControl, GoalStatus, GoalView, HostAction, HostEvent, SnapshotSection,
};

use super::{Win, capability, sid, window};

const OBJECTIVE: &str = "Move the parser behind a trait";
const WITHHELD: &str = "Goal mode is off in the settings";

/// The words a status is stated in, and the controls it allows.
const fn policy(status: GoalStatus) -> (&'static str, &'static [GoalControl]) {
	match status {
		GoalStatus::Active => ("Active", &[GoalControl::Pause, GoalControl::Drop]),
		GoalStatus::Paused => ("Paused", &[GoalControl::Resume, GoalControl::Drop]),
		GoalStatus::BudgetLimited => ("Budget limited", &[GoalControl::Resume, GoalControl::Drop]),
		GoalStatus::Complete => ("Complete", &[GoalControl::Drop]),
		GoalStatus::Dropped => ("Dropped", &[]),
	}
}

/// The words a control's button is drawn with.
const fn words(control: GoalControl) -> &'static str {
	match control {
		GoalControl::Pause => "Pause",
		GoalControl::Resume => "Resume",
		GoalControl::Drop => "Drop",
	}
}

/// Presses the key bound to `control`.
fn press(w: &mut Win<'_>, control: GoalControl) {
	match control {
		GoalControl::Pause => w.dispatch(PauseGoal),
		GoalControl::Resume => w.dispatch(ResumeGoal),
		GoalControl::Drop => w.dispatch(DropGoal),
	}
}

/// The host stating session `s` runs a goal in `status`, three turns and
/// seven minutes in, 20k of a 50k token budget spent.
fn goal(status: GoalStatus) -> HostEvent {
	let view = GoalView {
		objective: OBJECTIVE.to_owned(),
		status,
		driving: status == GoalStatus::Active,
		tokens_used: 20_000,
		token_budget: Some(50_000),
		turns_completed: 3,
		time_used_seconds: 420,
		created_at_ms: 0,
		updated_at_ms: 0,
		stood_down: (status == GoalStatus::BudgetLimited)
			.then(|| "the token budget is spent".to_owned()),
	};
	HostEvent::Snapshot(SnapshotSection::Goal { session: sid(), goal: Some(view) })
}

#[gpui::test]
fn every_goal_status_draws_its_own_words_and_only_the_controls_it_allows(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	for status in GoalStatus::iter() {
		w.apply(vec![goal(status)]);
		let (said, allowed) = policy(status);
		let pinned = status != GoalStatus::Dropped;
		let facts = format!("{said} · 3 turns · 20.0k / 50.0k tokens · 7m 00s");
		assert_eq!(w.drew(&facts), pinned, "the dock states {status:?} as {facts:?}");
		assert_eq!(w.drew(OBJECTIVE), pinned, "the dock pins the objective of {status:?}");
		assert!(w.drew(&format!("Goal: {said} · 3 turns")), "the footer states {status:?}");
		assert_eq!(
			w.drew("Stood down: the token budget is spent"),
			status == GoalStatus::BudgetLimited,
			"why the host stood down is drawn with its goal"
		);
		for control in GoalControl::iter() {
			let offered = allowed.contains(&control);
			assert_eq!(w.drew(words(control)), offered, "{status:?} offers {control:?}: {offered}");
			press(&mut w, control);
			let expected = if offered {
				vec![HostAction::ControlGoal { session: sid(), op: control }]
			} else {
				Vec::new()
			};
			assert_eq!(w.sent(), expected, "{control:?} on a {status:?} goal");
		}
	}
}

#[test]
fn every_goal_control_states_its_words_and_whether_it_ends_the_goal() {
	let stated: Vec<(&str, bool)> = GoalControl::iter()
		.map(|control| (control.label(), control.ends_the_goal()))
		.collect();
	assert_eq!(
		stated,
		[("Pause", false), ("Resume", false), ("Drop", true)],
		"only Drop is drawn as the control that discards the run"
	);
}

#[gpui::test]
fn the_draft_sets_the_goal_and_a_host_without_goals_takes_no_goal_request(
	app: &mut TestAppContext,
) {
	// Withheld before anything is sent: a request in flight reads as pending
	// and hides the capability's reason until the host answers it.
	let mut w =
		window(app, vec![goal(GoalStatus::Active), capability(Capability::Goals, Some(WITHHELD))]);
	assert!(w.drew(WITHHELD), "the goal states why its controls are held");
	w.write("Ship the lexer");
	w.dispatch(SetGoalFromDraft);
	assert_eq!(w.sent(), Vec::new(), "a withheld goal is not set");
	assert_eq!(w.draft(), "Ship the lexer", "and its objective stays in the draft");
	for control in GoalControl::iter() {
		press(&mut w, control);
		assert_eq!(w.sent(), Vec::new(), "{control:?} is held back");
	}

	w.apply(vec![capability(Capability::Goals, None)]);
	assert!(!w.drew(WITHHELD));
	w.dispatch(SetGoalFromDraft);
	assert_eq!(w.sent(), vec![HostAction::SetGoal {
		session:      sid(),
		objective:    "Ship the lexer".to_owned(),
		token_budget: None,
	}]);
	assert_eq!(w.draft(), "", "the objective leaves the draft once sent");
	w.write("   ");
	w.dispatch(SetGoalFromDraft);
	assert_eq!(w.sent(), Vec::new(), "a blank draft sets no goal");
	press(&mut w, GoalControl::Pause);
	assert_eq!(w.sent(), vec![HostAction::ControlGoal {
		session: sid(),
		op:      GoalControl::Pause,
	}]);
}
