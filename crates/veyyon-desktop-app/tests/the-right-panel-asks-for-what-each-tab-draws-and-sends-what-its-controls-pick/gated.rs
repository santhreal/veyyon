//! A panel tab leaves a request unsent only for the capability that answers
//! that request, and every tab stays in the strip whatever the host declines
//! or has not stated.
//!
//! WHY: the retired window listed the Changes tab only while `PendingEdits`
//! was offered, and the host declares that unavailable on every connection, so
//! the diff was unreachable while the host answered `Changes`. The class is a
//! tab emptied by a capability that fills no part of it, and a tab emptied by
//! silence rather than by a refusal. The sweep declines, then leaves unstated,
//! each capability of `Capability::ALL` alone and visits each tab of
//! `PanelTab::ALL`, recording which of the tab's own requests went unsent and
//! for which capability; the record is pinned by exact equality, so a
//! capability that starts withholding a tab's request, or a tab added to the
//! panel, is a decision to record here.
//!
//! Gap: which capabilities the host declares is the host's suites'; what a
//! tab draws in place of a declined domain is `declined.rs` and `usage.rs`.

use std::collections::{BTreeMap, BTreeSet};

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{Capability, CapabilityStatus, HostEvent, SnapshotSection};

use super::{
	harness::{SESSION, Win, answer, opened, window},
	loads,
};

/// Each tab's name, with the (capability, request) pairs it left unsent.
type Unsent = BTreeMap<&'static str, BTreeSet<(&'static str, &'static str)>>;

/// The host answering every capability but `capability`, which it states as
/// `status`.
fn all_but(capability: Capability, status: &CapabilityStatus) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(
		Capability::ALL
			.into_iter()
			.map(|each| {
				let stated = if each == capability {
					status.clone()
				} else {
					CapabilityStatus::Available
				};
				(each, stated)
			})
			.collect(),
	))
}

/// Visits every tab with each capability in turn stated as `status`, the
/// rest answered, and records what each tab left unsent.
fn sweep(w: &mut Win<'_>, status: &CapabilityStatus) -> Unsent {
	let mut unsent: Unsent = PanelTab::ALL
		.into_iter()
		.map(|tab| (tab.name(), BTreeSet::new()))
		.collect();
	for capability in Capability::ALL {
		w.apply(vec![all_but(capability, status)]);
		let settled = w.requests();
		answer(w, settled);
		for tab in PanelTab::ALL {
			w.click(&format!("panel.tab:{}", tab.name()));
			for each in PanelTab::ALL {
				let target = format!("panel.tab:{}", each.name());
				assert!(w.bounds(&target).is_some(), "{each:?} stays in the strip ({capability:?})");
			}
			let asked = w.requests();
			let sent: Vec<_> = asked.iter().map(|request| request.action.clone()).collect();
			let own = loads(tab);
			assert!(
				sent.iter().all(|action| own.contains(action)),
				"{tab:?} asks only for what it draws ({capability:?} {status:?}): {sent:?}"
			);
			for action in own.iter().filter(|action| !sent.contains(action)) {
				let pair = (capability.as_str(), action.kind().as_str());
				unsent.entry(tab.name()).or_default().insert(pair);
			}
			answer(w, asked);
		}
	}
	unsent
}

#[gpui::test]
fn a_tab_leaves_a_request_unsent_only_for_the_capability_that_answers_it(app: &mut TestAppContext) {
	// The strip selects only a change of tab, so the sweep starts on the tab
	// each of its rounds visits last and every click is a visit.
	let [.., last] = PanelTab::ALL;
	let mut w = window(app, opened(SESSION));
	w.open(last);
	let first = w.requests();
	answer(&mut w, first);

	let declined = sweep(&mut w, &CapabilityStatus::Unavailable { reason: "declined".to_owned() });
	let expected: Unsent = [
		("diff", vec![("Changes", "RefreshChanges")]),
		("files", vec![("Files", "LoadFileTree")]),
		("agents", vec![("Agents", "RefreshAgents")]),
		("todo", Vec::new()),
		("diagnostics", vec![("Diagnostics", "RefreshDiagnostics")]),
		("usage", vec![("Usage", "GetUsage"), ("ContextBreakdown", "GetContextBreakdown")]),
	]
	.into_iter()
	.map(|(tab, pairs)| (tab, pairs.into_iter().collect()))
	.collect();
	assert_eq!(
		declined, expected,
		"a declined capability withholds only the requests it answers; a new one is a decision to \
		 record here"
	);

	let silent = sweep(&mut w, &CapabilityStatus::UnknownUntilAttached);
	let nothing: Unsent = PanelTab::ALL
		.into_iter()
		.map(|tab| (tab.name(), BTreeSet::new()))
		.collect();
	assert_eq!(silent, nothing, "a capability the host has not stated withholds nothing");
}
