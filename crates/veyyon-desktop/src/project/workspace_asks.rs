//! What the workspace panel asks the host for.
//!
//! The panel's tabs draw domains the host answers only when it is asked, so
//! opening the panel and moving between its tabs are asks. Each one is gated on
//! the capability that fills the tab, so a host offering none is sent nothing.

use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, SessionId, Store};
use veyyon_desktop_surface::PanelTab;

/// Whether the host has stated that it offers `capability`. A capability it
/// has not answered for yet is not offered: a request sent against it is
/// refused, and the tab that would send it is still drawn as unknown.
pub(super) const fn offers(store: &Store, capability: Capability) -> bool {
	matches!(store.capabilities.get(capability), CapabilityStatus::Available)
}

/// What moving to `tab` asks for.
///
/// A workspace that changed outside a turn -- a command run in the drawer, an
/// edit made by hand -- reaches no client until something asks again, and
/// moving to the tab is that ask.
pub(super) fn tab_actions(
	tab: PanelTab,
	store: &Store,
	active: Option<SessionId>,
) -> Vec<HostAction> {
	match tab {
		PanelTab::Diff if offers(store, Capability::Changes) => vec![HostAction::RefreshChanges],
		PanelTab::Tree if offers(store, Capability::Files) => {
			// The root the client loaded, so a re-statement lands on the
			// directory it is drawing rather than resetting to the workspace
			// root.
			vec![HostAction::LoadFileTree {
				root: store
					.domains
					.file_tree
					.as_ref()
					.map(|tree| tree.root.clone()),
			}]
		},
		// The tab holds one file, and only a path already open can be read
		// again; a tab drawing an export asks for nothing.
		PanelTab::File if offers(store, Capability::Files) => store
			.domains
			.file_content
			.get()
			.map_or_else(Vec::new, |file| vec![HostAction::ReadFile { path: file.path.clone() }]),
		PanelTab::Usage if offers(store, Capability::Usage) => active
			.map_or_else(Vec::new, |session| vec![HostAction::GetUsage { session: Some(session) }]),
		PanelTab::Diff | PanelTab::Tree | PanelTab::File | PanelTab::Usage => Vec::new(),
	}
}

/// What opening the panel asks for: the changes it reports for the workspace,
/// and the tree when no client has loaded one yet.
pub(super) fn open_actions(store: &Store) -> Vec<HostAction> {
	let mut actions = Vec::new();
	if offers(store, Capability::Changes) {
		actions.push(HostAction::RefreshChanges);
	}
	if store.domains.file_tree.is_none() && offers(store, Capability::Files) {
		actions.push(HostAction::LoadFileTree { root: None });
	}
	actions
}
