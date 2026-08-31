//! WHY: the store raises intent while applying an event — a capability
//! snapshot asks for the session index — and a drain that submits only before
//! applying leaves that request sitting in the queue until the next poll. On
//! the idle interval that is a fifth of a second of a window drawn empty, and
//! on a window nobody touches again it is forever, because the poll that would
//! have carried it is the one this pass just finished.
//!
//! The class is intent raised inside `apply` rather than by a keystroke. It
//! closes at the drain, which is the one place both halves meet, rather than at
//! each event that might raise a request.
//!
//! Not covered: what the engine answers, and whether the transport delivers it.
//! Those are the transport suites.

use std::{
	collections::VecDeque,
	sync::{Arc, Mutex},
};

use veyyon_gui_core::{
	Store,
	command::UiCommand,
	host::{HostAction, HostEvent, HostRequest, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState},
};

use crate::bridge::{Adapter, Bridge};

/// The bridge owns its adapter, so what was submitted is read back through a
/// handle the test keeps.
struct Recorder {
	submitted: Arc<Mutex<Vec<HostRequest>>>,
	events:    VecDeque<HostEvent>,
}

impl Adapter for Recorder {
	fn submit(&mut self, request: HostRequest) {
		if let Ok(mut held) = self.submitted.lock() {
			held.push(request);
		}
	}

	fn next_event(&mut self) -> Option<HostEvent> {
		self.events.pop_front()
	}
}

fn drained(events: Vec<HostEvent>) -> (Vec<HostRequest>, Store) {
	drain_over(Store::detached(), events)
}

fn drain_over(mut store: Store, events: Vec<HostEvent>) -> (Vec<HostRequest>, Store) {
	let submitted = Arc::new(Mutex::new(Vec::new()));
	let mut bridge = Bridge::attached(Box::new(Recorder {
		submitted: submitted.clone(),
		events:    VecDeque::from(events),
	}));
	bridge.drain(&mut store, |_| {});
	let sent = submitted
		.lock()
		.map(|held| held.clone())
		.unwrap_or_default();
	(sent, store)
}

fn opening() -> Vec<HostEvent> {
	vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "unix:/run/veyyon/gui-host.sock".to_owned(),
			protocol: 1,
		}),
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Sessions,
			CapabilityStatus::Available,
		)])),
	]
}

#[test]
fn the_pass_that_applied_the_capabilities_also_sends_the_request() {
	let (sent, mut store) = drained(opening());
	assert!(
		sent
			.iter()
			.any(|request| matches!(request.action, HostAction::ListSessions)),
		"the request the capability snapshot raised never left this pass: {sent:?}"
	);
	assert!(
		store.drain_requests().is_empty(),
		"a request was left in the queue for a poll that may never come"
	);
}

#[test]
fn a_pass_with_nothing_to_apply_sends_nothing() {
	let (sent, _) = drained(Vec::new());
	assert!(
		sent.is_empty(),
		"a drain with no events and no typed intent invented a request: {sent:?}"
	);
}

#[test]
fn intent_typed_between_two_passes_leaves_on_the_next_one() {
	// A keystroke dispatches while nothing is being applied, so its request is
	// queued before the pass that carries it. That is the other half of the
	// drain, and it stays covered when the half above changes.
	let (_, mut store) = drained(opening());
	let effects = store.dispatch(UiCommand::LoadSessions);
	assert_eq!(effects.requests.len(), 1, "the dispatch raised no request to carry");

	let (sent, mut store) = drain_over(store, Vec::new());
	assert_eq!(sent, effects.requests, "a request queued before the pass was not carried by it");
	assert!(store.drain_requests().is_empty());
}
