//! WHY: the Changes tab was listed only while `PendingEdits` was anything but
//! `Unavailable`, and the engine host declares `PendingEdits` unavailable on
//! every connection. The whole diff surface — hunks, scopes, intraline
//! highlighting — was therefore unreachable in the shipped product while the
//! host answered `Changes` perfectly well.
//!
//! CLASS CLOSED: a panel tab hidden by a capability that fills no part of it.
//! The sweep reads `Capability::ALL` and `PanelTab::all()` at run time, so a
//! capability added to the protocol, or a tab added to the panel, is covered
//! without an edit here, and a tab that grows a second gate turns this red.
//!
//! NOT CAUGHT: what a tab draws once it is offered (the diff row suites own
//! that), the host action a tab opening requests
//! (`control-availability-and-contextual-statuses-project-from-capabilities.
//! rs`), and which capabilities the TypeScript host declares, which
//! `packages/coding-agent/test/gui-host/every-host-action-has-a-dispatcher.
//! test.ts` pins.

use std::collections::{BTreeMap, BTreeSet};

use veyyon_desktop::project::project_panel;
use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, ChangeScope, ChangeStatus, ChangedFile,
	ChangesView, Domains,
};
use veyyon_desktop_surface::{PanelContent, PanelTab};

/// A host that answers everything, so the only reason a tab is missing below is
/// the one capability the case took away.
fn all_available() -> CapabilityMap {
	let mut capabilities = CapabilityMap::new();
	for capability in Capability::ALL {
		capabilities.set(capability, CapabilityStatus::Available);
	}
	capabilities
}

fn without(capability: Capability) -> CapabilityMap {
	let mut capabilities = all_available();
	capabilities.set(capability, CapabilityStatus::Unavailable {
		reason: format!("{} is off on this host", capability.as_str()),
	});
	capabilities
}

fn one_changed_file() -> Domains {
	Domains {
		changes: Some(ChangesView {
			revision:       1,
			repository:     Some("/repo".to_string()),
			scope:          ChangeScope::WorkingTree,
			files:          vec![ChangedFile {
				path:          "ledger.rs".to_string(),
				previous_path: None,
				status:        ChangeStatus::Modified,
				additions:     4,
				deletions:     4,
			}],
			diff:           String::new(),
			diff_truncated: false,
			files_withheld: 0,
		})
		.into(),
		..Domains::default()
	}
}

fn tabs_for(capabilities: &CapabilityMap) -> Vec<PanelTab> {
	project_panel(&Domains::default(), capabilities, None, PanelContent::default()).tabs
}

#[test]
fn a_tab_is_hidden_only_by_the_capability_that_fills_it() {
	assert_eq!(
		tabs_for(&all_available()),
		vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree, PanelTab::Usage],
		"a host that answers every capability offers every tab"
	);

	let mut hidden_by: BTreeMap<&'static str, BTreeSet<&'static str>> = PanelTab::all()
		.into_iter()
		.map(|tab| (tab.label(), BTreeSet::new()))
		.collect();
	for capability in Capability::ALL {
		let offered = tabs_for(&without(capability));
		for tab in PanelTab::all() {
			if !offered.contains(&tab) {
				hidden_by
					.get_mut(tab.label())
					.expect("every tab was seeded above")
					.insert(capability.as_str());
			}
		}
	}

	let expected: BTreeMap<&'static str, BTreeSet<&'static str>> = [
		("Changes", BTreeSet::from(["Changes"])),
		("File", BTreeSet::from(["Files"])),
		("Tree", BTreeSet::from(["Files"])),
		("Usage", BTreeSet::from(["Usage"])),
	]
	.into_iter()
	.collect();
	assert_eq!(
		hidden_by, expected,
		"a tab is withdrawn by its own capability and by no other; a new gate is a decision to \
		 record here"
	);
}

#[test]
fn the_snapshot_the_engine_host_sends_offers_the_changes_tab() {
	// What `SUPPORTED_CAPABILITIES` in the host's session bridge amounts to on
	// the wire: three capabilities unavailable, the other twenty-seven answered.
	let host_declines = ["PendingEdits", "Extensions", "AgentCommands"];
	let mut capabilities = all_available();
	for capability in Capability::ALL {
		if host_declines.contains(&capability.as_str()) {
			capabilities.set(capability, CapabilityStatus::Unavailable {
				reason: format!("{} is not supported by this host version", capability.as_str()),
			});
		}
	}

	let panel = project_panel(&one_changed_file(), &capabilities, None, PanelContent::default());

	assert_eq!(
		panel.tabs,
		vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree, PanelTab::Usage],
		"the shipped host offers the diff tab beside the file tabs"
	);
	assert_eq!(panel.active_tab, PanelTab::Diff, "the panel opens on the tab it defaults to");
	assert_eq!(panel.unavailable_reason, None, "a panel with tabs states no reason it has none");
	assert_eq!(
		panel
			.diff
			.iter()
			.map(|file| file.path.as_str())
			.collect::<Vec<_>>(),
		vec!["ledger.rs"],
		"the tab is filled by the changes the host reported"
	);
}

#[test]
fn the_changes_tab_waits_for_the_capability_that_fills_it() {
	let mut unknown = all_available();
	unknown.set(Capability::Changes, CapabilityStatus::UnknownUntilAttached);
	assert!(
		!tabs_for(&unknown).contains(&PanelTab::Diff),
		"a host that has not answered Changes yet offers no diff tab"
	);

	let refused = without(Capability::Changes);
	assert!(
		!tabs_for(&refused).contains(&PanelTab::Diff),
		"a host that refuses Changes offers no diff tab"
	);

	let remembered = PanelContent { active_tab: PanelTab::Diff, ..PanelContent::default() };
	let panel = project_panel(&Domains::default(), &refused, None, remembered);
	assert_eq!(
		panel.active_tab,
		PanelTab::File,
		"a remembered tab the host no longer offers falls back to the first one that is offered"
	);
}
