//! The session mode: stated in the thread header and the composer footer as
//! the host last stated it, and set for the open session from its actions
//! and from the footer's picker.
//!
//! WHY: a mode decides the tools the agent holds and how its turn ends. A
//! window that states no mode draws a plan-restricted session identical to
//! an unrestricted one, and a chip that outlives the mode's exit announces a
//! restriction that is gone. A mode reachable only from the terminal cannot
//! be entered or left from the window, and a row that sends a mode other
//! than the one it names puts the session where nobody asked. A control live
//! while the host sets no mode sends a request the host refuses. The sweeps
//! read `SessionModeKind` and `SettableMode` at run time, and each member's
//! words and reach are an exhaustive match, so a new mode fails to compile
//! here until its row is written.
//!
//! Gap: `SessionMode::Other` is swept with one name; the picker's check mark
//! and its "Review the plan" row are not read; a window with no session open
//! is not driven, since the harness always opens one.

use gpui::TestAppContext;
use strum::IntoEnumIterator;
use veyyon_desktop_app::actions::composer::{ClearMode, SetModeLoop, SetModePlan, SetModeVibe};
use veyyon_desktop_model::{Capability, HostAction, SessionMode, SessionModeKind, SettableMode};

use super::{Win, capability, header, sid, window};

/// One mode of `kind`, and the words the header and the footer state it in.
fn stated(kind: SessionModeKind) -> (SessionMode, &'static str, &'static str) {
	match kind {
		SessionModeKind::Plan => (SessionMode::Plan, "Plan", "Plan mode"),
		SessionModeKind::PlanPaused => (SessionMode::PlanPaused, "Plan paused", "Plan paused"),
		SessionModeKind::Goal => (SessionMode::Goal, "Goal", "Goal mode"),
		SessionModeKind::Vibe => (SessionMode::Vibe, "Vibe", "Vibe mode"),
		SessionModeKind::Loop => (SessionMode::Loop, "Loop", "Loop mode"),
		SessionModeKind::Other => {
			(SessionMode::Other("rehearsal".to_owned()), "rehearsal", "rehearsal")
		},
	}
}

/// Dispatches the action that sets `mode`.
fn set_by_action(w: &mut Win<'_>, mode: SettableMode) {
	match mode {
		SettableMode::Plan => w.dispatch(SetModePlan),
		SettableMode::Vibe => w.dispatch(SetModeVibe),
		SettableMode::Loop => w.dispatch(SetModeLoop),
		SettableMode::None => w.dispatch(ClearMode),
	}
}

/// The footer picker's row that sets `mode`.
const fn picker_row(mode: SettableMode) -> &'static str {
	match mode {
		SettableMode::Plan => "Plan mode",
		SettableMode::Vibe => "Vibe mode",
		SettableMode::Loop => "Loop mode",
		SettableMode::None => "No mode",
	}
}

fn set(mode: SettableMode) -> Vec<HostAction> {
	vec![HostAction::SetSessionMode { session: sid(), mode }]
}

#[gpui::test]
fn every_mode_the_host_states_is_drawn_in_the_header_and_the_footer_until_it_leaves(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	assert!(w.drew("Chat"), "a session in no mode states the footer's default");
	let mut revision = 1;
	for kind in SessionModeKind::iter() {
		let (mode, in_header, in_footer) = stated(kind);
		revision += 1;
		w.apply(vec![header(Some(mode.wire_name()), revision)]);
		// Where both state a mode in one phrase, each draws its own run.
		let runs = if in_header == in_footer { 2 } else { 1 };
		assert_eq!(w.count(in_header), runs, "the header states {mode:?} as {in_header:?}");
		assert_eq!(w.count(in_footer), runs, "the footer states {mode:?} as {in_footer:?}");
		assert!(!w.drew("Chat"), "the footer drops its default for {mode:?}");

		revision += 1;
		w.apply(vec![header(Some("none"), revision)]);
		assert!(!w.drew(in_header), "leaving {mode:?} takes the header's chip off");
		assert!(!w.drew(in_footer), "leaving {mode:?} takes the footer's words off");
		assert!(w.drew("Chat"));
	}
}

#[gpui::test]
fn every_settable_mode_is_sent_for_the_open_session_from_its_action_and_its_picker_row(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	for mode in SettableMode::iter() {
		set_by_action(&mut w, mode);
		assert_eq!(w.sent(), set(mode), "the action for {mode:?} sends it");

		let row = picker_row(mode);
		w.click("composer.mode");
		assert!(w.drew(row), "the picker lists {row:?}");
		let initial = row[..1].to_lowercase();
		w.keys(&format!("{initial}->{initial} enter"));
		assert_eq!(w.sent(), set(mode), "the row {row:?} sends {mode:?}");
		assert!(!w.drew(row), "picking a row closes the picker");
	}
}

#[gpui::test]
fn a_host_that_sets_no_mode_takes_no_mode_request(app: &mut TestAppContext) {
	let mut w =
		window(app, vec![capability(Capability::Sessions, Some("this host keeps no modes"))]);
	for mode in SettableMode::iter() {
		set_by_action(&mut w, mode);
		assert_eq!(w.sent(), Vec::new(), "{mode:?} is held back");
	}
	w.click("composer.mode");
	assert!(!w.drew(picker_row(SettableMode::Plan)), "the chip opens no picker");

	w.apply(vec![capability(Capability::Sessions, None)]);
	set_by_action(&mut w, SettableMode::Plan);
	assert_eq!(w.sent(), set(SettableMode::Plan), "a granted mode takes the request");
}
