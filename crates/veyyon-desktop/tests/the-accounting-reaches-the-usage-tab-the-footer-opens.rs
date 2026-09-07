//! WHY: `EntryMeta.usage` reached no surface. The host reported an open
//! session's accounting and the window had nowhere to draw it, so the turn
//! footer's model name led to a tab that did not exist. This suite is the
//! usage half of the projection: the totals reaching the panel, the tab
//! appearing only where the host answers for it, and the tab the operator
//! opened surviving the next snapshot.
//!
//! CLASS CLOSED: a panel tab the projection offers for a capability the host
//! refused, and a projection that closes a tab the window owns. Both are the
//! same defect in either direction — the host and the window disagreeing about
//! who owns `panel.tabs`.
//!
//! NOT CAUGHT: whether the usage view draws the figures correctly; that is
//! `a-turn-names-the-model-that-produced-it-and-the-name-opens-the-accounting`
//! in the surface crate. The session, changes and drawer halves are in
//! `the-host-model-projects-onto-the-shell.rs`.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostEvent, QueuePartition, SessionId, SnapshotSection, Store,
	UsageTotals, UsageView, reduce,
};
use veyyon_desktop_surface::{PanelTab, ShellState};

#[test]
fn the_open_session_s_accounting_reaches_the_usage_tab_and_a_refusal_takes_the_tab_away() {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let totals = UsageTotals {
		input_tokens:         1_200,
		output_tokens:        340,
		cache_read_tokens:    9_000,
		cache_write_tokens:   120,
		orchestration_tokens: 40,
		premium_requests:     3,
		cost_microusd:        Some(21_000),
	};
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Usage(UsageView {
			session: SessionId::from("s"),
			totals:  totals.clone(),
		})),
	);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(
		state.panel.usage.as_ref(),
		Some(&totals),
		"the usage tab draws {:?}: the accounting the turn footer leads to is the open session's, \
		 as the host reported it",
		state.panel.usage
	);
	assert!(
		state.panel.tabs.contains(&PanelTab::Usage),
		"the panel lists {:?}, so the footer's click has no tab to land on",
		state.panel.tabs
	);

	store
		.capabilities
		.set(Capability::Usage, CapabilityStatus::Unavailable {
			reason: "this host keeps no accounting".to_string(),
		});
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(
		!state.panel.tabs.contains(&PanelTab::Usage),
		"the panel still lists {:?} after the host refused usage: a tab offered for a capability \
		 the host declared unavailable opens on nothing",
		state.panel.tabs
	);
}

#[test]
fn a_usage_tab_the_footer_opened_survives_the_next_snapshot() {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));

	// The host has not answered the usage capability and has reported no
	// totals, which is the state the operator clicks the model name in.
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert!(
		!state.panel.tabs.contains(&PanelTab::Usage),
		"the panel lists {:?} before the operator asked for the accounting and before the host \
		 offered it, so a tab is drawn that opens on nothing",
		state.panel.tabs
	);

	state.panel.tabs.push(PanelTab::Usage);
	state.panel.active_tab = PanelTab::Usage;
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(
		state.panel.tabs.contains(&PanelTab::Usage),
		"the panel lists {:?} after an unrelated snapshot: the tab the operator opened from the \
		 turn footer is the window's, so a re-projection closes the panel they are reading",
		state.panel.tabs
	);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::Usage,
		"the projection moved the operator off the tab they opened to {:?}",
		state.panel.active_tab
	);
}
