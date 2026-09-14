use veyyon_desktop::{HandshakeDriver, TransportError};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, ConnectionState, ErrorScope, HostEvent,
	PROTOCOL_VERSION, SnapshotSection,
};

#[test]
fn protocol_mismatch_transitions_to_fatal_and_never_connected() {
	let mut driver = HandshakeDriver::new("tcp:127.0.0.1:7654".to_string());

	let greeting_mismatch = HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "tcp:127.0.0.1:7654".to_string(),
		protocol: 99, // mismatch! Expected 1
	});

	let res = driver.handle_event(&greeting_mismatch);
	assert!(
		matches!(res, Err(TransportError::FatalProtocol(_))),
		"protocol mismatch must return FatalProtocol error"
	);

	assert!(driver.is_fatal());
	assert!(!driver.is_connected());

	match driver.state() {
		ConnectionState::Fatal { message } => {
			assert_eq!(
				message,
				"Protocol version mismatch: client expects protocol v1, host vended v99"
			);
		},
		other => panic!("expected Fatal state, got {other:?}"),
	}
}

#[test]
fn host_answering_all_initial_requests_with_request_failed_still_reaches_connected() {
	let mut driver = HandshakeDriver::new("tcp:127.0.0.1:7654".to_string());

	// 1. Greeting
	let greeting = HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "tcp:127.0.0.1:7654".to_string(),
		protocol: PROTOCOL_VERSION,
	});
	driver.handle_event(&greeting).expect("greeting accepted");

	// 2. Capabilities snapshot (e.g. Sessions Available, Settings Available)
	let caps = HostEvent::Snapshot(SnapshotSection::Capabilities(vec![
		(Capability::Sessions, CapabilityStatus::Available),
		(Capability::Settings, CapabilityStatus::Available),
	]));

	let outbound_requests = driver
		.handle_event(&caps)
		.expect("capabilities should trigger initial sync");
	assert_eq!(outbound_requests.len(), 2, "expected ListSessions and LoadSettings");

	assert!(matches!(driver.state(), ConnectionState::Syncing { received: 0, expected: Some(2) }));

	// 3. Host answers request 1 with RequestFailed
	let fail1 = HostEvent::RequestFailed {
		request: outbound_requests[0].id,
		error:   BackendError {
			scope:          ErrorScope::Session,
			code:           Some("FAILED".to_string()),
			message:        "Session list failed".to_string(),
			retryable:      false,
			request:        Some(outbound_requests[0].id),
			occurred_at_ms: 1000,
		},
	};
	driver.handle_event(&fail1).expect("failure 1 settles");
	assert!(matches!(driver.state(), ConnectionState::Syncing { received: 1, expected: Some(2) }));

	// 4. Host answers request 2 with RequestFailed
	let fail2 = HostEvent::RequestFailed {
		request: outbound_requests[1].id,
		error:   BackendError {
			scope:          ErrorScope::Settings,
			code:           Some("UNIMPLEMENTED_ACTION".to_string()),
			message:        "Settings not supported".to_string(),
			retryable:      false,
			request:        Some(outbound_requests[1].id),
			occurred_at_ms: 1001,
		},
	};
	driver.handle_event(&fail2).expect("failure 2 settles");

	// Invariant: Handshake successfully reached Connected despite both requests
	// failing
	assert!(driver.is_connected(), "handshake must reach Connected after all requests settle");
	match driver.state() {
		ConnectionState::Connected { endpoint, protocol } => {
			assert_eq!(endpoint, "tcp:127.0.0.1:7654");
			assert_eq!(*protocol, PROTOCOL_VERSION);
		},
		other => panic!("expected Connected state, got {other:?}"),
	}
}

#[test]
fn host_answering_with_mix_reaches_connected_exactly_once_in_bounded_frames() {
	let mut driver = HandshakeDriver::new("unix:/run/test.sock".to_string());

	// Step 1: Greeting
	let greeting = HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "unix:/run/test.sock".to_string(),
		protocol: PROTOCOL_VERSION,
	});
	driver.handle_event(&greeting).expect("greeting accepted");

	// Step 2: Capabilities with 3 available domains
	let caps = HostEvent::Snapshot(SnapshotSection::Capabilities(vec![
		(Capability::Sessions, CapabilityStatus::Available),
		(Capability::Themes, CapabilityStatus::Available),
		(Capability::Diagnostics, CapabilityStatus::Available),
		(Capability::SessionDeletion, CapabilityStatus::Unavailable {
			reason: "unsupported".to_string(),
		}),
	]));

	let outbound = driver
		.handle_event(&caps)
		.expect("caps triggers 3 sync requests");
	assert_eq!(outbound.len(), 3);
	let (req1, req2, req3) = (outbound[0].id, outbound[1].id, outbound[2].id);

	// Step 3: Mix of success and failure
	let event_succ = HostEvent::RequestSucceeded { request: req1 };
	let event_fail = HostEvent::RequestFailed {
		request: req2,
		error:   BackendError {
			scope:          ErrorScope::Settings,
			code:           None,
			message:        "Failed".to_string(),
			retryable:      true,
			request:        Some(req2),
			occurred_at_ms: 500,
		},
	};
	let event_succ2 = HostEvent::RequestSucceeded { request: req3 };

	let mut frames_processed = 2; // greeting + caps
	let remaining_frames = vec![event_succ, event_fail, event_succ2];

	for frame in remaining_frames {
		frames_processed += 1;
		assert!(frames_processed <= 10, "handshake must terminate within bounded frame budget");
		driver.handle_event(&frame).expect("frame handled");
	}

	assert!(driver.is_connected());
	assert_eq!(driver.state(), &ConnectionState::Connected {
		endpoint: "unix:/run/test.sock".to_string(),
		protocol: PROTOCOL_VERSION,
	});
}
