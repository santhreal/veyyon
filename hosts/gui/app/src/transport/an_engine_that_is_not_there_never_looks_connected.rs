//! WHY: a window that draws a product it cannot reach is worse than a window
//! that draws nothing, because the reader acts on it. The defect class is a
//! transport that reports a state it has no evidence for: a `Connected` state
//! with no greeting behind it, a protocol mismatch that half-works, a payload
//! accepted from a peer that never said what it speaks, or an unusable endpoint
//! that becomes a panic or a blank instead of a reason.
//!
//! Each test drives the real [`Session`] over a real loopback socket against
//! [`engine_double`](super::engine_double), and the last drives the production
//! [`Bridge`] and [`Store`], so what is asserted is the state a surface reads.
//!
//! Bounds are asserted, not assumed: every wait has a deadline, and the paths
//! that must stop are asserted to stop, because a transport that hangs shows
//! the reader the same blank frame as one that is merely slow.
//!
//! What it does not catch: reconnection, which
//! `a_dropped_connection_comes_back_and_says_when` owns; and the unix socket
//! family, which shares one code path with TCP above `Socket::connect` and is
//! reached here only through a failure to connect.

use std::time::Duration;

use veyyon_gui_core::{
	Store, UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState},
};

use super::{
	engine_double::{DEADLINE, Engine, events_until, ever_connected, nobody, quick, states},
	outbox::now_ms,
	session::{PROTOCOL, Session},
};
use crate::bridge::Bridge;

fn fatal(event: &HostEvent) -> bool {
	matches!(event, HostEvent::ConnectionChanged(ConnectionState::Fatal { .. }))
}

#[test]
fn an_address_nobody_answers_reports_each_attempt_and_then_stops() {
	let mut session = Session::with_policy(nobody(), quick(Some(2)));
	let seen = events_until(&mut session, fatal, DEADLINE);
	let states = states(&seen);

	assert!(
		matches!(states.first(), Some(ConnectionState::Connecting { attempt: 1 })),
		"the first thing a reader sees is the attempt, not a blank: {states:?}"
	);
	assert!(
		states
			.iter()
			.any(|state| matches!(state, ConnectionState::Reconnecting { attempt: 2, .. })),
		"the wait before the second attempt is a state of its own: {states:?}"
	);
	assert!(
		matches!(states.last(), Some(ConnectionState::Fatal { .. })),
		"an attempt ceiling ends the session rather than retrying forever: {states:?}"
	);
	assert!(
		!ever_connected(&states),
		"no path reports a connection that was never made: {states:?}"
	);
}

#[test]
fn a_wait_states_when_the_next_attempt_is_due() {
	let policy = quick(Some(2));
	let before = now_ms();
	let mut session = Session::with_policy(nobody(), policy);
	let seen = events_until(
		&mut session,
		|event| matches!(event, HostEvent::ConnectionChanged(ConnectionState::Reconnecting { .. })),
		DEADLINE,
	);
	let observed = states(&seen);
	let Some(ConnectionState::Reconnecting { retry_at_ms, message, .. }) = observed.last() else {
		panic!("a failed attempt is followed by a wait: {observed:?}");
	};

	let backoff = u64::try_from(policy.first_backoff.as_millis()).unwrap_or_default();
	assert!(
		*retry_at_ms >= before,
		"the time of the next attempt is not in the past: {retry_at_ms} < {before}"
	);
	assert!(
		*retry_at_ms <= before + backoff + 2_000,
		"the wait is bounded by the backoff, not open-ended: {retry_at_ms} > {before} + {backoff}"
	);
	assert!(!message.trim().is_empty(), "the wait says what went wrong with the last attempt");
}

#[test]
fn an_engine_speaking_another_protocol_is_fatal_and_is_not_retried() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.greet(PROTOCOL + 1);

	let seen = events_until(&mut session, fatal, DEADLINE);
	let observed = states(&seen);
	let Some(ConnectionState::Fatal { message }) = observed.last() else {
		panic!("a protocol mismatch is fatal: {observed:?}");
	};
	assert!(
		message.contains(&(PROTOCOL + 1).to_string()) && message.contains(&PROTOCOL.to_string()),
		"the reader is told which protocol each side speaks: {message}"
	);
	assert!(
		!ever_connected(&observed),
		"a greeting this side cannot honour never reads as connected: {observed:?}"
	);
	assert!(
		engine.accept(Duration::from_millis(200)).is_none(),
		"a fault that repeats forever is not retried"
	);
}

#[test]
fn an_engine_that_speaks_before_greeting_is_fatal() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.send(&HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Sessions,
		CapabilityStatus::Available,
	)])));

	let seen = events_until(&mut session, fatal, DEADLINE);
	let observed = states(&seen);
	assert!(
		matches!(observed.last(), Some(ConnectionState::Fatal { .. })),
		"a payload before a greeting is a protocol fault: {observed:?}"
	);
	assert!(
		!seen
			.iter()
			.any(|event| matches!(event, HostEvent::Snapshot(_))),
		"nothing an ungreeted engine sent reaches the store: {seen:?}"
	);
}

#[test]
fn a_frame_this_side_cannot_read_is_fatal_and_is_not_retried() {
	let engine = Engine::bind();
	let mut session = Session::with_policy(engine.endpoint(), quick(None));
	let mut peer = engine.accept(DEADLINE).expect("the session connects");
	peer.greet(PROTOCOL);
	peer.write_bytes(b"{\"NotAnEvent\":true}\n");

	let seen = events_until(&mut session, fatal, DEADLINE);
	let observed = states(&seen);
	assert!(
		matches!(observed.last(), Some(ConnectionState::Fatal { .. })),
		"a frame that is not this protocol ends the session: {observed:?}"
	);
	assert!(
		engine.accept(Duration::from_millis(200)).is_none(),
		"reconnecting would replay the same unreadable frame, so it is not attempted"
	);
}

#[test]
fn an_endpoint_that_is_not_an_address_is_a_state_and_not_a_panic() {
	let session = Session::fatal(
		"VEYYON_GUI_ENDPOINT is not an address: tcp: was given nothing to connect to".to_owned(),
	);
	let mut bridge = Bridge::attached(Box::new(session));
	let mut store = Store::detached();
	bridge.drain(&mut store, |_| {});

	let ConnectionState::Fatal { message } = &store.connection else {
		panic!("an unusable endpoint is shown as fatal: {:?}", store.connection);
	};
	assert!(
		message.contains("VEYYON_GUI_ENDPOINT"),
		"the reader is told which setting is wrong: {message}"
	);

	store.dispatch(UiCommand::RetryConnection);
	bridge.drain(&mut store, |_| {});
	assert!(
		matches!(store.connection, ConnectionState::Fatal { .. }),
		"retrying an address that cannot be parsed reports no progress it did not make"
	);
	assert!(
		store
			.replica
			.notifications
			.entries()
			.iter()
			.any(|notice| notice
				.detail
				.as_deref()
				.is_some_and(|detail| { detail.contains("VEYYON_GUI_ENDPOINT") })),
		"the failure is posted where a reader who was not watching the titlebar sees it"
	);
}
