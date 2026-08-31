//! Detached initialization, capability negotiation, and correlated request
//! emission.

use crate::{
	command::UiCommand,
	host::{HostEvent, SnapshotSection},
	model::*,
	store::{CommandTarget, Store},
};

#[test]
fn detached_store_contains_no_product_replicas() {
	let mut store = Store::detached();
	assert_eq!(store.connection, ConnectionState::Detached);
	assert!(matches!(&store.replica.workspaces, RemoteData::Unrequested));
	assert!(matches!(&store.replica.sessions.sessions, RemoteData::Unrequested));
	assert!(matches!(&store.replica.transcript, RemoteData::Unrequested));
	assert!(matches!(&store.replica.terminals, RemoteData::Unrequested));
	assert!(matches!(&store.replica.models, RemoteData::Unrequested));
	assert!(matches!(&store.replica.agents, RemoteData::Unrequested));
	assert!(store.replica.capabilities.is_empty());
	assert!(store.drain_requests().is_empty());
}

#[test]
fn host_requests_are_correlated_and_pending_before_emission() {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Available,
	)])));
	// The capability snapshot asks for the index on its own, which
	// `a_window_that_just_attached_asks_for_what_it_draws` covers. This test is
	// about the correlation of an explicit request, so that one leaves the queue
	// first.
	let _ = store.drain_requests();
	let effects = store.dispatch(UiCommand::LoadSessions);
	assert_eq!(effects.requests.len(), 1);
	let request = effects.requests[0].id;
	assert_eq!(store.command_state(&CommandTarget::Sessions), CommandState::Pending { request });
	assert_eq!(store.drain_requests(), effects.requests);
	store.apply(HostEvent::RequestSucceeded { request });
	assert_eq!(store.command_state(&CommandTarget::Sessions), CommandState::Idle);
	assert!(
		store
			.apply(HostEvent::RequestSucceeded { request })
			.ignored_stale_event
	);
}

#[test]
fn unavailable_capability_emits_neither_request_nor_pending_state() {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Unavailable { reason: "not exposed".to_owned() },
	)])));
	let effects = store.dispatch(UiCommand::LoadSessions);
	assert!(effects.requests.is_empty());
	assert_eq!(store.command_state(&CommandTarget::Sessions), CommandState::Idle);
	assert!(!effects.shell.is_empty());
}
