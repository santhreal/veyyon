//! WHY: an engine restarts, a tunnel drops, a laptop sleeps. The defect class
//! is a transport that treats the first connection as the only one: intent
//! pressed while the socket was down disappears, the second connection is never
//! attempted, the reader is shown a stale `Connected` state over a dead socket,
//! or the window closes and leaves a thread parked on a read forever.
//!
//! Each test drives the real [`Session`] over a real loopback socket against
//! [`engine_double`](super::engine_double), and the first drives the production
//! [`Bridge`] and [`Store`] so the values a surface reads are what is asserted.
//!
//! What it does not catch: the fatal paths, which
//! `an_engine_that_is_not_there_never_looks_connected` owns, and the ceiling on
//! how long a backoff grows, which is a property of `Policy` arithmetic rather
//! than of a connection.

use std::{
	thread::sleep,
	time::{Duration, Instant},
};

use veyyon_gui_core::{
	Store,
	host::{HostAction, HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState, RemoteData, StaleReason, Versioned},
};

use super::{
	engine_double::{DEADLINE, Engine, events_until, quick, request, states},
	session::{PROTOCOL, Session},
};
use crate::bridge::{Adapter, Bridge};

fn connected(event: &HostEvent) -> bool {
	matches!(event, HostEvent::ConnectionChanged(ConnectionState::Connected { .. }))
}

#[test]
fn a_greeted_engine_reaches_the_store_and_its_frames_follow() {
	let engine = Engine::bind();
	let session = Session::with_policy(engine.endpoint(), quick(None));
	let mut bridge = Bridge::attached(Box::new(session));
	let mut store = Store::detached();
	let mut peer = engine.accept(DEADLINE).expect("the session connects");

	assert!(!store.connection.is_connected(), "a window with nothing applied is not connected");
	peer.greet(PROTOCOL);
	peer.send(&HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Available,
	)])));

	let deadline = Instant::now() + DEADLINE;
	while store.replica.capabilities.get(&Capability::Sessions) != Some(&CapabilityStatus::Available)
	{
		assert!(Instant::now() < deadline, "the engine's frames reach the store");
		bridge.drain(&mut store, |_| {});
		sleep(Duration::from_millis(1));
	}
	assert!(
		store.connection.is_connected(),
		"the greeting the engine sent is the state the window shows: {:?}",
		store.connection
	);
}

#[test]
fn a_dropped_connection_is_retried_and_the_second_one_works() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let mut first = engine.accept(DEADLINE).expect("the session connects");
	first.greet(PROTOCOL);
	assert!(
		!events_until(&mut session, connected, DEADLINE).is_empty(),
		"the first connection is reported before it is dropped"
	);
	drop(first);

	let mut second = engine
		.accept(DEADLINE)
		.expect("a dropped connection is made again");
	second.greet(PROTOCOL);
	let observed = states(&events_until(&mut session, connected, DEADLINE));
	assert!(
		observed
			.iter()
			.any(|state| matches!(state, ConnectionState::Reconnecting { .. })),
		"the gap between two connections is a state the reader sees: {observed:?}"
	);
	assert!(
		matches!(observed.last(), Some(ConnectionState::Connected { .. })),
		"the second connection is a connection: {observed:?}"
	);
}

#[test]
fn what_a_dropped_connection_left_behind_is_marked_stale() {
	// The values on screen were true of a connection that is gone. Keeping them
	// is right, and presenting them as current is the defect.
	let engine = Engine::bind();
	let session = Session::with_policy(engine.endpoint(), quick(None));
	let mut bridge = Bridge::attached(Box::new(session));
	let mut store = Store::detached();
	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.greet(PROTOCOL);
	peer.send(&HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 1,
		value:    Vec::new(),
	})));

	let deadline = Instant::now() + DEADLINE;
	while !matches!(store.replica.transcript, RemoteData::Ready(_)) {
		assert!(
			Instant::now() < deadline,
			"the engine's transcript reaches the store: {:?}",
			store.connection
		);
		bridge.drain(&mut store, |_| {});
		sleep(Duration::from_millis(1));
	}
	drop(peer);

	let deadline = Instant::now() + DEADLINE;
	loop {
		bridge.drain(&mut store, |_| {});
		if matches!(store.replica.transcript, RemoteData::Stale {
			reason: StaleReason::Disconnected,
			..
		}) {
			break;
		}
		assert!(
			Instant::now() < deadline,
			"a dropped connection marks what it left behind: {:?} / {:?}",
			store.connection,
			store.replica.transcript
		);
		sleep(Duration::from_millis(1));
	}
	assert!(
		!store.connection.is_connected(),
		"a dead socket is not shown as a live one: {:?}",
		store.connection
	);
}

#[test]
fn intent_dispatched_before_a_socket_exists_is_written_when_one_appears() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let waiting = request(11, HostAction::ListSessions);
	session.submit(waiting.clone());

	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.greet(PROTOCOL);
	assert_eq!(
		peer.read_request(),
		Some(waiting),
		"a request pressed while the socket was being made is written, not dropped"
	);

	let deadline = Instant::now() + DEADLINE;
	while session.pending() > 0 {
		assert!(Instant::now() < deadline, "the queue drains once a writer exists");
		sleep(Duration::from_millis(1));
	}
}

#[test]
fn intent_pressed_between_two_connections_reaches_the_second_one() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let mut first = engine.accept(DEADLINE).expect("the session connects");
	first.greet(PROTOCOL);
	events_until(&mut session, connected, DEADLINE);
	drop(first);

	let pressed = request(21, HostAction::RetryConnection);
	session.submit(pressed.clone());

	let mut second = engine
		.accept(DEADLINE)
		.expect("a dropped connection is made again");
	second.greet(PROTOCOL);
	assert_eq!(
		second.read_request(),
		Some(pressed),
		"a request pressed while the engine was away is written to the connection that follows"
	);
}

#[test]
fn closing_the_window_releases_the_socket() {
	let engine = Engine::bind();
	let session = Session::with_policy(engine.endpoint(), quick(None));
	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.greet(PROTOCOL);

	drop(session);

	assert!(
		peer.closed_within(DEADLINE),
		"a closed window ends the connection instead of leaving a thread parked on a read"
	);
}
