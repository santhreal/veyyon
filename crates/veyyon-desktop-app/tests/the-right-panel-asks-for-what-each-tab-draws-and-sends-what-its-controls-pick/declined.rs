//! A host that declines what a tab draws is asked nothing for it, and the
//! tab states the host's reason: the diff tab for a host that reads no
//! repository, the files tab for one that browses no files. A host that
//! later takes it is asked once. A host that keeps no edit buffer still has
//! its changes drawn, under its reason.
//!
//! WHY: a tab that asks a declining host anyway spends a refusal per visit
//! and draws "not loaded" with a load button that can never load, so the
//! reason the host gave is the one thing the operator needs and the one
//! thing such a tab never shows.
//!
//! Gap: the agents, diagnostics and usage tabs draw their refusals on their
//! refresh controls; those are not driven here.

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, HostEvent, SnapshotSection};

use super::{
	changes,
	harness::{SESSION, opened, window},
	loads,
};

/// The host stating it declines each capability of `declined` for its
/// reason.
fn declines(declined: &[(Capability, &str)]) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(
		declined
			.iter()
			.map(|&(capability, reason)| {
				(capability, CapabilityStatus::Unavailable { reason: reason.to_owned() })
			})
			.collect(),
	))
}

#[gpui::test]
fn a_tab_whose_capability_the_host_declines_states_why_and_asks_nothing(app: &mut TestAppContext) {
	let mut events = opened(SESSION);
	events.push(declines(&[
		(Capability::Changes, "Not a git repository"),
		(Capability::Files, "This host browses no files"),
	]));
	let mut w = window(app, events);

	w.open(PanelTab::Diff);
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a declined diff is not asked for");
	assert!(w.draws("Not a git repository"), "the diff tab states why: {:?}", w.texts());
	assert!(!w.draws("Changes have not loaded"), "and offers no load that cannot load");

	w.click("panel.tab:files");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a declined tree is not asked for");
	assert!(w.draws("This host browses no files"), "the files tab states why: {:?}", w.texts());
	assert!(!w.draws("The project tree has not loaded"));

	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Capabilities(vec![
		(Capability::Changes, CapabilityStatus::Available),
		(Capability::Files, CapabilityStatus::Available),
	]))]);
	assert_eq!(w.sent(), loads(PanelTab::Files), "a host that takes the shown tree is asked for it");
	w.click("panel.tab:diff");
	assert_eq!(w.sent(), loads(PanelTab::Diff), "and for the diff once it is shown");
}

#[gpui::test]
fn a_host_with_no_edit_buffer_states_why_above_the_changes_it_still_draws(
	app: &mut TestAppContext,
) {
	let mut events = opened(SESSION);
	events.push(declines(&[(Capability::PendingEdits, "This host keeps no edit buffer")]));
	let mut w = window(app, events);

	w.open(PanelTab::Diff);
	assert_eq!(w.sent(), loads(PanelTab::Diff), "the changes are still asked for");
	w.apply(vec![changes()]);
	assert!(w.draws("This host keeps no edit buffer"), "the reason is drawn: {:?}", w.texts());
	assert!(w.draws("fn new_one() {}"), "above the diff it still draws");
}
