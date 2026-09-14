//! WHY THIS SUITE EXISTS:
//! The transport built one `ReconnectPolicy` for the life of the window and
//! never reset it. Every disconnection the window recovered from still spent
//! an attempt out of the ten §8.13 allows, so a window left open across ten
//! host restarts -- a `veyyon` upgrade, a crash, a laptop lid, hours apart --
//! was told "Connection failed after 10 retry attempts (120s elapsed)" and
//! offered a manual re-attach, with no attempt having failed. The same
//! accumulation slowed every recovery before that one: the second restart
//! waited the second attempt's backoff, the fifth the fifth's, for a host that
//! was already listening.
//!
//! THE CLASS THIS CLOSES:
//! A bounded-retry ceiling that a success does not clear, in either
//! direction. The suite drives the real `spawn_transport` against a real
//! socket and reads the states it publishes, so it covers the reset (a
//! recovered connection restarts the count and the delay) and its sibling
//! defect (a socket that accepts and closes without ever completing a
//! handshake must NOT restart the count, or a host in a crash-loop is retried
//! forever and never reaches the fatal state that offers the way out).
//!
//! WHAT IT DOES NOT CATCH:
//! That the ceiling terminates at all, and the shape of the backoff curve,
//! which `reconnect_backoff_schedule_bounds_and_terminates.rs` owns against
//! the policy directly -- ten real attempts take the two minutes §8.13
//! authors, which is not a thing to spend in a test. It also reads the
//! transport's own events rather than the banner drawn from them, which
//! `one-connection-failure-is-stated-once-with-one-way-out.rs` owns.

use std::time::{Duration, Instant};

use tokio::{
	io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
	net::{TcpListener, TcpStream},
	sync::mpsc::Receiver,
};
use veyyon_desktop::{Endpoint, max_jitter_delay_ms, spawn_transport};
use veyyon_desktop_model::{
	ConnectionState, HostEvent, HostRequest, PROTOCOL_VERSION, SnapshotSection,
};

/// How long any single wait in this suite may take before the test fails as a
/// timeout rather than stalling: several times the first attempt's backoff
/// band, and far under the ceiling the policy would reach.
const WAIT: Duration = Duration::from_secs(10);

/// The slack allowed on a measured recovery, over the widest delay the first
/// attempt's jitter band authors. It covers the accept, the handshake and the
/// scheduler, and stays well under the second attempt's own band (675ms at
/// the bottom of its jitter), so a ceiling that failed to reset is caught by
/// the reading rather than by the tolerance.
const RECOVERY_SLACK_MS: u64 = 400;

/// Serves one handshake the way the host does: the connected state, the
/// capability snapshot the client syncs against, and a settlement for every
/// request the client sends back.
///
/// Returns the accepted stream, whose drop is what disconnects the client.
async fn serve_handshake(listener: &TcpListener, endpoint: &str) -> TcpStream {
	let (stream, _) = listener.accept().await.expect("the client connected");
	let mut reader = BufReader::new(stream);

	send(
		&mut reader,
		&HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: endpoint.to_owned(),
			protocol: PROTOCOL_VERSION,
		}),
	)
	.await;
	send(&mut reader, &HostEvent::Snapshot(SnapshotSection::Capabilities(Vec::new()))).await;

	// The client answers a capability snapshot with its initial sync, which is
	// `ListSessions` alone while no capability is available. Settling it is what
	// completes the handshake.
	let mut line = String::new();
	reader
		.read_line(&mut line)
		.await
		.expect("the client sent its initial sync");
	let request: HostRequest = serde_json::from_str(line.trim()).expect("a request frame");
	send(&mut reader, &HostEvent::RequestSucceeded { request: request.id }).await;

	reader.into_inner()
}

/// Writes one line-delimited event frame to the client.
async fn send(reader: &mut BufReader<TcpStream>, event: &HostEvent) {
	let mut frame = serde_json::to_string(event).expect("an encodable event");
	frame.push('\n');
	reader
		.get_mut()
		.write_all(frame.as_bytes())
		.await
		.expect("the client is still reading");
}

/// Reads ingress until the transport reports it is connected.
async fn wait_for_connected(events: &mut Receiver<HostEvent>) {
	let waited = tokio::time::timeout(WAIT, async {
		while let Some(event) = events.recv().await {
			if matches!(event, HostEvent::ConnectionChanged(ConnectionState::Connected { .. })) {
				return;
			}
		}
		panic!("the transport closed its ingress before connecting");
	})
	.await;
	assert!(waited.is_ok(), "the transport never reported a connection");
}

/// Reads ingress until the transport reports it is reconnecting, and answers
/// with the attempt number it is on.
async fn wait_for_reconnecting(events: &mut Receiver<HostEvent>) -> u32 {
	let waited = tokio::time::timeout(WAIT, async {
		while let Some(event) = events.recv().await {
			match event {
				HostEvent::ConnectionChanged(ConnectionState::Reconnecting { attempt, .. }) => {
					return attempt;
				},
				HostEvent::ConnectionChanged(ConnectionState::Fatal { message }) => {
					panic!("the transport gave up instead of reconnecting: {message}");
				},
				_ => {},
			}
		}
		panic!("the transport closed its ingress before reconnecting");
	})
	.await;
	waited.expect("the transport never reported a reconnection")
}

#[tokio::test]
async fn a_recovered_connection_restarts_the_retry_count() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("a local listener");
	let address = listener.local_addr().expect("a bound address");
	let endpoint = Endpoint::parse(&format!("tcp:{address}"), None).expect("a tcp endpoint");
	let (_egress, mut events, task) = spawn_transport(endpoint);

	let mut attempts = Vec::new();
	for _ in 0..3 {
		let stream = serve_handshake(&listener, &address.to_string()).await;
		wait_for_connected(&mut events).await;
		drop(stream);
		attempts.push(wait_for_reconnecting(&mut events).await);
	}

	task.abort();
	assert_eq!(
		attempts,
		vec![1, 1, 1],
		"each disconnection a recovered connection follows is the first attempt again"
	);
}

#[tokio::test]
async fn a_recovery_after_a_recovery_waits_no_longer_than_the_first_one() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("a local listener");
	let address = listener.local_addr().expect("a bound address");
	let endpoint = Endpoint::parse(&format!("tcp:{address}"), None).expect("a tcp endpoint");
	let (_egress, mut events, task) = spawn_transport(endpoint);

	let ceiling = max_jitter_delay_ms(1) + RECOVERY_SLACK_MS;
	let mut waits = Vec::new();
	for _ in 0..3 {
		let stream = serve_handshake(&listener, &address.to_string()).await;
		wait_for_connected(&mut events).await;
		let dropped = Instant::now();
		drop(stream);
		wait_for_reconnecting(&mut events).await;
		// The connection is back once the next handshake completes, which the
		// next pass through the loop serves; the reading is the span the operator
		// waits, so it ends where the transport is ready to be served again.
		let back = serve_handshake(&listener, &address.to_string()).await;
		wait_for_connected(&mut events).await;
		let waited = u64::try_from(dropped.elapsed().as_millis()).unwrap_or(u64::MAX);
		waits.push(waited);
		drop(back);
		wait_for_reconnecting(&mut events).await;
	}

	task.abort();
	let slowest = waits.iter().copied().max().unwrap_or_default();
	assert!(
		slowest <= ceiling,
		"every recovery waits inside the first attempt's band ({ceiling}ms), got {waits:?}"
	);
}

#[tokio::test]
async fn a_socket_that_never_completes_a_handshake_keeps_spending_the_ceiling() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("a local listener");
	let address = listener.local_addr().expect("a bound address");
	let endpoint = Endpoint::parse(&format!("tcp:{address}"), None).expect("a tcp endpoint");
	let (_egress, mut events, task) = spawn_transport(endpoint);

	// A host in a crash loop: the port is bound, every connection is accepted
	// and dropped, and no handshake ever completes. The ceiling has to keep
	// counting, or the window retries a dead host forever instead of arriving
	// at the state that offers a way out.
	let mut attempts = Vec::new();
	for _ in 0..3 {
		let (stream, _) = listener.accept().await.expect("the client connected");
		drop(stream);
		attempts.push(wait_for_reconnecting(&mut events).await);
	}

	task.abort();
	assert_eq!(
		attempts,
		vec![1, 2, 3],
		"a connection that never completed its handshake is not a connection that worked"
	);
}

#[tokio::test]
async fn a_handshake_that_got_halfway_keeps_spending_the_ceiling() {
	let listener = TcpListener::bind("127.0.0.1:0")
		.await
		.expect("a local listener");
	let address = listener.local_addr().expect("a bound address");
	let endpoint = Endpoint::parse(&format!("tcp:{address}"), None).expect("a tcp endpoint");
	let (_egress, mut events, task) = spawn_transport(endpoint);

	// The same crash loop, further in: the host answers, the client sends its
	// initial sync, and the host dies before settling any of it. Events crossed
	// and the handshake still never completed, so the ceiling keeps counting.
	// A ceiling cleared by any byte from the host retries this forever.
	let mut attempts = Vec::new();
	for _ in 0..3 {
		let (stream, _) = listener.accept().await.expect("the client connected");
		let mut reader = BufReader::new(stream);
		send(
			&mut reader,
			&HostEvent::ConnectionChanged(ConnectionState::Connected {
				endpoint: address.to_string(),
				protocol: PROTOCOL_VERSION,
			}),
		)
		.await;
		send(&mut reader, &HostEvent::Snapshot(SnapshotSection::Capabilities(Vec::new()))).await;
		let mut line = String::new();
		reader
			.read_line(&mut line)
			.await
			.expect("the client sent its initial sync");
		drop(reader);
		attempts.push(wait_for_reconnecting(&mut events).await);
	}

	task.abort();
	assert_eq!(
		attempts,
		vec![1, 2, 3],
		"a handshake that never settled its sync is not a connection that worked"
	);
}
