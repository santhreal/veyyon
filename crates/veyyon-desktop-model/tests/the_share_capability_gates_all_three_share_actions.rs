//! WHY: sharing a session over a relay adds three host actions --
//! `StartShare`, `StopShare` and `RefreshShare`. One of them left off the
//! `Share` gate is a control drawn against a host that cannot answer it, and
//! the press comes back refused after the card has already stated that the
//! session is going out over a relay.
//!
//! THE CLASS THIS CLOSES: a share action that reaches a host without its
//! capability checked. The share family is read off `HostActionKind` at run
//! time rather than listed here, and pinned by exact equality, so a fourth
//! share action turns this red until it is written down. Each one is gated
//! through both entry points -- `gate` on the action and `gate_kind` on its
//! discriminant -- in every state a gate resolves: `Unknown` before a host
//! attached, `Unavailable` while the host states it cannot share, `Enabled`
//! once it can, and `Pending` while a request is in flight.
//!
//! WHAT IT DOES NOT CATCH: whether a relay URL is well formed, and what
//! happens to a share whose relay drops mid-session.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{
	Capability, CapabilityMap, CapabilityStatus, Gate, HostAction, HostActionKind, RequestId,
	RequestRegistry, SurfaceId, action_to_capability, gate, gate_kind,
};

/// Every action a host answers for a share, with both spellings of the one
/// that carries a choice, so a read-only share is gated like a writable one.
fn share_actions() -> Vec<HostAction> {
	vec![
		HostAction::StartShare { read_only: false },
		HostAction::StartShare { read_only: true },
		HostAction::StopShare,
		HostAction::RefreshShare,
	]
}

#[test]
fn the_share_family_is_the_three_actions_named_here_and_no_others() {
	let gated: Vec<String> = HostActionKind::iter()
		.filter(|kind| action_to_capability(*kind) == Capability::Share)
		.map(|kind| format!("{kind:?}"))
		.collect();

	assert_eq!(
		gated,
		vec!["StartShare".to_owned(), "StopShare".to_owned(), "RefreshShare".to_owned()],
		"the actions the share capability gates are read off the action kinds themselves, so a \
		 fourth one is recorded here or it is not gated"
	);
}

#[test]
fn no_share_action_is_offered_before_a_host_states_it_can_share() {
	let capabilities = CapabilityMap::new();
	let registry = RequestRegistry::new();

	for action in share_actions() {
		assert_eq!(
			gate(&action, &capabilities, &registry),
			Gate::Unknown,
			"{:?} is unknown while no host has stated what it can do",
			action.kind()
		);
		assert_eq!(
			gate_kind(action.kind(), &capabilities, &registry),
			Gate::Unknown,
			"{:?} is unknown by its kind as well as by the action",
			action.kind()
		);
	}
}

#[test]
fn a_host_that_cannot_share_refuses_every_share_action_with_its_own_reason() {
	let mut capabilities = CapabilityMap::new();
	let registry = RequestRegistry::new();
	let reason = "the relay is off".to_owned();
	capabilities.set(Capability::Share, CapabilityStatus::Unavailable { reason: reason.clone() });

	for action in share_actions() {
		assert_eq!(
			gate(&action, &capabilities, &registry),
			Gate::Unavailable { reason: reason.clone() },
			"{:?} carries the reason the host gave rather than a bare refusal",
			action.kind()
		);
		assert_eq!(
			gate_kind(action.kind(), &capabilities, &registry),
			Gate::Unavailable { reason: reason.clone() },
			"{:?} is refused by its kind as well as by the action",
			action.kind()
		);
	}
}

#[test]
fn a_host_that_can_share_offers_every_share_action() {
	let mut capabilities = CapabilityMap::new();
	let registry = RequestRegistry::new();
	capabilities.set(Capability::Share, CapabilityStatus::Available);

	for action in share_actions() {
		assert_eq!(
			gate(&action, &capabilities, &registry),
			Gate::Enabled,
			"{:?} is offered once the host states it can share",
			action.kind()
		);
	}
}

#[test]
fn a_share_action_in_flight_is_pending_until_the_host_answers_it() {
	let mut capabilities = CapabilityMap::new();
	let mut registry = RequestRegistry::new();
	capabilities.set(Capability::Share, CapabilityStatus::Available);
	let request = RequestId(42);

	registry.register(
		request,
		HostActionKind::StartShare,
		SurfaceId::GlobalTitlebarLine,
		1000,
		5000,
	);

	assert_eq!(
		gate_kind(HostActionKind::StartShare, &capabilities, &registry),
		Gate::Pending { request },
		"a share the host has not answered yet is pending rather than offered again"
	);
	assert_eq!(
		gate_kind(HostActionKind::StopShare, &capabilities, &registry),
		Gate::Pending { request },
		"a share request in flight holds back the whole family, so the card offers no second \
		 control while the first is unanswered"
	);

	registry.complete(&request);

	assert_eq!(
		gate_kind(HostActionKind::StartShare, &capabilities, &registry),
		Gate::Enabled,
		"the action is offered again once the host has answered"
	);
}
