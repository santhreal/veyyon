//! WHY: The share card drew its Start, Stop and Refresh controls at rest and
//! attached their presses unconditionally, so a host that withholds
//! `Capability::Share`, or one still answering an earlier press, was sent the
//! request anyway. The card also read no projection for those controls, which
//! is the state `ControlStates::unprojected` exists to report.
//!
//! THE CLASS THIS CLOSES: a share action reachable from a control that no
//! projection covers. The sweep is over the gate table rather than a list
//! written here: every `HostActionKind` whose capability is `Capability::Share`
//! must be carried by at least one control in `gated_controls`, so a seventh
//! share action turns this red until it has a control, and a control removed
//! from the projection turns it red too.
//!
//! WHAT IT DOES NOT CATCH: what the card draws for a refused control. The
//! opacity and the suppressed press are the surface crate's, and the rendered
//! frame is the scene sweep's.

use std::collections::{BTreeMap, BTreeSet};

use veyyon_desktop::{SessionIndex, project::gated_controls};
use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, Gate, HostActionKind, RequestRegistry, Store,
	SurfaceId, action_to_capability, gate_kind,
};

/// Every action kind the gate table assigns to `Capability::Share`.
fn share_actions() -> BTreeSet<HostActionKind> {
	HostActionKind::ALL
		.into_iter()
		.filter(|kind| action_to_capability(*kind) == Capability::Share)
		.collect()
}

/// The controls the window projects, by the action each one sends.
fn projected_by_action() -> BTreeMap<HostActionKind, Vec<SurfaceId>> {
	let store = Store::new();
	let index = SessionIndex::new();
	let mut by_action: BTreeMap<HostActionKind, Vec<SurfaceId>> = BTreeMap::new();
	for (surface, action) in gated_controls(&store, &index, None) {
		by_action.entry(action).or_default().push(surface);
	}
	by_action
}

#[test]
fn every_share_action_is_carried_by_a_control_the_window_projects() {
	let projected = projected_by_action();
	let uncarried: Vec<HostActionKind> = share_actions()
		.into_iter()
		.filter(|kind| !projected.contains_key(kind))
		.collect();
	assert_eq!(
		uncarried,
		Vec::<HostActionKind>::new(),
		"a share action the host answers has no control that sends it"
	);
}

#[test]
fn the_share_controls_are_the_six_the_card_draws() {
	let projected = projected_by_action();
	let mut share_controls: Vec<SurfaceId> = share_actions()
		.into_iter()
		.filter_map(|kind| projected.get(&kind).cloned())
		.flatten()
		.collect();
	share_controls.sort();
	assert_eq!(share_controls, vec![
		SurfaceId::ShareStartButton,
		SurfaceId::ShareStartReadOnlyButton,
		SurfaceId::ShareStopButton,
		SurfaceId::ShareRefreshButton,
		SurfaceId::ShareJoinButton,
		SurfaceId::ShareLeaveButton,
	]);
}

#[test]
fn a_host_that_withholds_sharing_leaves_every_share_control_unavailable() {
	let mut capabilities = CapabilityMap::default();
	capabilities.set(Capability::Share, CapabilityStatus::Unavailable {
		reason: "this host does not share".to_owned(),
	});
	let registry = RequestRegistry::default();
	for kind in share_actions() {
		assert!(
			matches!(gate_kind(kind, &capabilities, &registry), Gate::Unavailable { .. }),
			"{kind:?} is pressable on a host that does not share"
		);
	}
}

#[test]
fn a_share_control_reads_unknown_until_the_window_has_attached() {
	// The fourth state (§1.2): before the greeting there is no answer to draw
	// a refusal from, and a control drawn as refused there states something
	// the host never said.
	let capabilities = CapabilityMap::default();
	let registry = RequestRegistry::default();
	for kind in share_actions() {
		assert_eq!(gate_kind(kind, &capabilities, &registry), Gate::Unknown, "{kind:?}");
	}
}

#[test]
fn a_share_capability_the_host_offers_makes_its_controls_pressable() {
	let mut capabilities = CapabilityMap::default();
	capabilities.set(Capability::Share, CapabilityStatus::Available);
	let registry = RequestRegistry::default();
	for kind in share_actions() {
		assert_eq!(
			gate_kind(kind, &capabilities, &registry),
			Gate::Enabled,
			"{kind:?} is not pressable on a host that shares"
		);
	}
}
