//! WHY: attaching to an engine and asking it nothing draws an empty product
//! with a reload control on it, which reads as an engine that has no sessions
//! rather than a window that never asked. The capability snapshot is the first
//! moment the window knows what the engine can answer, so it is where the
//! opening request belongs.
//!
//! The class this closes is the automatic request, which has three ways to be
//! wrong and one of them is silent: asking a host that cannot answer, asking
//! twice for one value, and asking again for a value already held. A second
//! capability snapshot arrives on every reconnection, so the repeat case is the
//! ordinary case rather than an edge.
//!
//! Not covered: what the engine answers with, and what the conversation route
//! draws once it does. Those are the snapshot tests.

use crate::{
	host::{HostAction, HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState, RemoteData, SessionSummary, Versioned},
	store::{CommandTarget, Store},
};

fn attached(status: CapabilityStatus) -> Store {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "tcp:127.0.0.1:7654".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		status,
	)])));
	store
}

fn session_list_requests(store: &mut Store) -> usize {
	store
		.drain_requests()
		.iter()
		.filter(|request| matches!(request.action, HostAction::ListSessions))
		.count()
}

#[test]
fn the_capability_snapshot_asks_for_the_session_index_once() {
	let mut store = attached(CapabilityStatus::Available);
	assert_eq!(
		session_list_requests(&mut store),
		1,
		"a window that knows the engine lists sessions asks for the list"
	);
}

#[test]
fn a_second_capability_snapshot_does_not_ask_again() {
	// A reconnection sends its capabilities again, and the request from the
	// first one is still in flight.
	let mut store = attached(CapabilityStatus::Available);
	assert_eq!(session_list_requests(&mut store), 1);

	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Available,
	)])));
	assert_eq!(
		session_list_requests(&mut store),
		0,
		"a request already in flight is not sent a second time"
	);
}

#[test]
fn a_value_already_held_is_not_asked_for() {
	let mut store = attached(CapabilityStatus::Available);
	// The opening request is answered, so nothing is in flight and only the held
	// value stands between a second snapshot and a second request.
	let opening = store.drain_requests();
	let request = opening[0].id;
	store.apply(HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: Vec::<SessionSummary>::new() },
		Vec::new(),
	)));
	store.apply(HostEvent::RequestSucceeded { request });
	assert!(matches!(store.replica.sessions.sessions, RemoteData::Ready(_)));
	assert!(!store.request_pending(&CommandTarget::Sessions));

	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Available,
	)])));
	assert_eq!(
		session_list_requests(&mut store),
		0,
		"the index is already here, so nothing asks for it again"
	);
}

#[test]
fn an_engine_that_cannot_list_sessions_is_not_asked() {
	for status in [
		CapabilityStatus::Unavailable { reason: "this host has no session index".to_owned() },
		CapabilityStatus::UnknownUntilAttached,
	] {
		let mut store = attached(status.clone());
		assert_eq!(
			session_list_requests(&mut store),
			0,
			"{status:?} was asked for a list it cannot produce"
		);
		assert!(
			matches!(store.replica.sessions.sessions, RemoteData::Unrequested),
			"{status:?} left the replica claiming a request that was never made"
		);
	}
}

#[test]
fn every_capability_the_opening_request_depends_on_is_stated() {
	// The set is pinned by equality rather than by count: a capability added to
	// the opening request without a decision recorded here turns this red.
	let opening: Vec<Capability> = Capability::ALL
		.into_iter()
		.filter(|capability| {
			let mut store = Store::detached();
			store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
				endpoint: "tcp:127.0.0.1:7654".to_owned(),
				protocol: 1,
			}));
			store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
				*capability,
				CapabilityStatus::Available,
			)])));
			!store.drain_requests().is_empty()
		})
		.collect();
	assert_eq!(
		opening,
		vec![Capability::Sessions],
		"the opening request asks for the session index and nothing else"
	);
}
