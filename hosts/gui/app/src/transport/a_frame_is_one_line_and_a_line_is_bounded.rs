//! WHY: a transport that loses one message loses the window's agreement with
//! the engine, and the two ways to lose one are silent. A frame boundary that
//! moves — a newline inside a payload, a line longer than the buffer, a
//! keep-alive read as a message — desynchronises the stream, and every frame
//! after it is misread. A request accepted by a full queue and then dropped
//! leaves a correlation id that never comes back, and the surface waiting on it
//! waits forever.
//!
//! The class this closes: framing that depends on payload content, and intent
//! that disappears between a control and a socket. Every failure the reader can
//! reach is named and separated into the ones worth retrying and the ones that
//! repeat forever.
//!
//! What it does not catch: a peer that frames correctly and lies about the
//! contents, and the socket itself, which
//! `an_engine_that_is_not_there_never_looks_connected` drives over a real one.

use std::{
	io::Cursor,
	sync::mpsc::{TryRecvError, channel},
};

use veyyon_gui_core::{
	host::{HostAction, HostEvent, HostRequest},
	model::{ConnectionState, RequestId, SessionId},
};

use super::{
	endpoint::{Endpoint, EndpointError},
	frames::{self, FrameError, MAX_FRAME_BYTES},
	outbox::{MAX_PENDING_REQUESTS, Outbox},
};

fn request(id: u64, action: HostAction) -> HostRequest {
	HostRequest { id: RequestId::new(id).expect("a nonzero correlation id"), action }
}

fn session(name: &str) -> SessionId {
	SessionId::new(name).expect("a nonempty session id")
}

#[test]
fn a_payload_carrying_a_newline_still_writes_one_line() {
	// The whole framing rests on this: serde escapes a newline inside a string,
	// so a prompt written across three lines is still one frame.
	let submitted = request(7, HostAction::RenameSession {
		session: session("s-1"),
		name:    "first\nsecond\r\n\"third\"".to_owned(),
	});
	let mut wire = Vec::new();
	frames::write(&mut wire, &submitted).expect("the frame writes");

	assert_eq!(
		wire.iter().filter(|byte| **byte == b'\n').count(),
		1,
		"a frame holds exactly one newline, its terminator"
	);
	assert_eq!(wire.last(), Some(&b'\n'), "the frame ends with its terminator");

	let mut source = Cursor::new(wire);
	let mut buffer = Vec::new();
	let read: HostRequest = frames::read(&mut source, &mut buffer).expect("the frame reads back");
	assert_eq!(read, submitted, "what was written is what is read");
}

#[test]
fn two_frames_in_one_read_stay_two_frames() {
	let first = request(1, HostAction::ListSessions);
	let second = request(2, HostAction::RetryConnection);
	let mut wire = Vec::new();
	frames::write(&mut wire, &first).expect("the first frame writes");
	frames::write(&mut wire, &second).expect("the second frame writes");

	let mut source = Cursor::new(wire);
	let mut buffer = Vec::new();
	let read_first: HostRequest = frames::read(&mut source, &mut buffer).expect("the first reads");
	let read_second: HostRequest = frames::read(&mut source, &mut buffer).expect("the second reads");
	assert_eq!((read_first, read_second), (first, second));
	assert!(
		matches!(frames::read::<HostRequest>(&mut source, &mut buffer), Err(FrameError::Closed)),
		"the stream ends between frames, which is a clean close"
	);
}

#[test]
fn a_blank_line_is_a_keep_alive_and_not_a_message() {
	let event = HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "tcp:127.0.0.1:1".to_owned(),
		protocol: 1,
	});
	let mut wire = Vec::from(b"\n\n\n");
	frames::write(&mut wire, &event).expect("the frame writes");

	let mut source = Cursor::new(wire);
	let mut buffer = Vec::new();
	let read: HostEvent = frames::read(&mut source, &mut buffer).expect("the frame reads");
	assert_eq!(read, event, "the blank lines held the connection open and said nothing");
}

#[test]
fn a_line_that_never_ends_ends_the_connection_instead() {
	// Without the bound this read grows until the process dies, so the
	// assertion that matters is that it returns at all.
	let unending = vec![b'x'; MAX_FRAME_BYTES + 1];
	let mut source = Cursor::new(unending);
	let mut buffer = Vec::new();
	let outcome = frames::read_line(&mut source, &mut buffer);
	assert!(
		matches!(outcome, Err(FrameError::TooLarge)),
		"a frame past the bound is reported, not buffered: {outcome:?}"
	);
	assert!(
		buffer.len() <= MAX_FRAME_BYTES,
		"the buffer stopped at the bound instead of holding the whole line"
	);
}

#[test]
fn each_failure_states_whether_repeating_it_could_help() {
	let closed = FrameError::Closed;
	let truncated = FrameError::Truncated;
	let too_large = FrameError::TooLarge;
	let malformed = FrameError::Malformed("a field was missing".to_owned());
	let broken = FrameError::Io(std::io::Error::other("the socket went away"));

	assert!(!closed.is_protocol_fault(), "a closed socket is worth reconnecting to");
	assert!(!truncated.is_protocol_fault(), "a truncated frame is worth reconnecting to");
	assert!(!broken.is_protocol_fault(), "a socket fault is worth reconnecting to");
	assert!(too_large.is_protocol_fault(), "an unbounded frame repeats forever");
	assert!(malformed.is_protocol_fault(), "unreadable JSON repeats forever");

	for failure in [closed, truncated, too_large, malformed, broken] {
		assert!(!failure.message().trim().is_empty(), "every failure says something to the reader");
	}
}

#[test]
fn bytes_that_are_not_the_json_this_side_speaks_are_a_protocol_fault() {
	let mut source = Cursor::new(Vec::from(b"{\"id\":1,\"action\":\"NoSuchAction\"}\n"));
	let mut buffer = Vec::new();
	let outcome = frames::read::<HostRequest>(&mut source, &mut buffer);
	match outcome {
		Err(error @ FrameError::Malformed(_)) => {
			assert!(error.is_protocol_fault(), "a frame this side cannot read repeats forever");
		},
		other => panic!("expected a malformed frame, got {other:?}"),
	}
}

#[test]
fn a_stream_that_stops_mid_frame_is_not_a_clean_close() {
	let mut source = Cursor::new(Vec::from(b"{\"id\":1,\"action\""));
	let mut buffer = Vec::new();
	let outcome = frames::read::<HostRequest>(&mut source, &mut buffer);
	assert!(
		matches!(outcome, Err(FrameError::Truncated)),
		"a half-written frame is a dropped connection, not an ending: {outcome:?}"
	);
}

#[test]
fn a_request_the_queue_cannot_hold_comes_back_failed() {
	let (sender, received) = channel();
	let outbox = Outbox::new(sender);
	for id in 1..=MAX_PENDING_REQUESTS {
		outbox.push(request(id as u64 + 1, HostAction::ListSessions));
	}
	assert_eq!(outbox.pending(), MAX_PENDING_REQUESTS, "the queue holds its bound and no more");
	assert!(
		matches!(received.try_recv(), Err(TryRecvError::Empty)),
		"nothing inside the bound was refused"
	);

	let refused = request(9_001, HostAction::RetryConnection);
	outbox.push(refused.clone());
	assert_eq!(outbox.pending(), MAX_PENDING_REQUESTS, "the bound held");
	match received.try_recv() {
		Ok(HostEvent::RequestFailed { request: id, error }) => {
			assert_eq!(id, refused.id, "the refusal answers the request that was refused");
			assert_eq!(error.request, Some(refused.id));
			assert!(error.retryable, "a full queue is a transient condition");
		},
		other => panic!("a refused request must be answered, got {other:?}"),
	}
}

#[test]
fn closing_the_window_answers_every_request_still_waiting() {
	let (sender, received) = channel();
	let outbox = Outbox::new(sender);
	let waiting: Vec<HostRequest> = (1..=3)
		.map(|id| request(id, HostAction::ListSessions))
		.collect();
	for pending in &waiting {
		outbox.push(pending.clone());
	}

	outbox.stop();

	let mut answered = Vec::new();
	while let Ok(HostEvent::RequestFailed { request: id, .. }) = received.try_recv() {
		answered.push(id);
	}
	assert_eq!(
		answered,
		waiting.iter().map(|pending| pending.id).collect::<Vec<_>>(),
		"every queued request is answered in order, so no correlation id is left open"
	);
	assert_eq!(outbox.pending(), 0, "nothing is left to write");

	let late = request(99, HostAction::RetryConnection);
	outbox.push(late.clone());
	assert!(
		matches!(
			received.try_recv(),
			Ok(HostEvent::RequestFailed { request: id, .. }) if id == late.id
		),
		"a request dispatched after the transport stopped is refused, not queued"
	);
	assert_eq!(outbox.pending(), 0);
}

#[test]
fn a_writer_from_a_dead_connection_takes_nothing() {
	let (sender, _received) = channel();
	let outbox = Outbox::new(sender);
	let stale = outbox.open();
	let current = outbox.open();
	assert_ne!(stale, current, "each connection writes under its own token");

	outbox.push(request(1, HostAction::ListSessions));
	assert!(
		outbox.take(stale).is_none(),
		"the previous connection's writer returns instead of writing to a dead socket"
	);
	assert!(outbox.take(current).is_some(), "the current writer takes the request");
}

#[test]
fn a_request_that_failed_to_write_is_written_first_next_time() {
	let (sender, _received) = channel();
	let outbox = Outbox::new(sender);
	let generation = outbox.open();
	let unsent = request(1, HostAction::ListSessions);
	outbox.push(request(2, HostAction::RetryConnection));
	outbox.return_unsent(unsent.clone());

	assert_eq!(
		outbox.take(generation).map(|taken| taken.id),
		Some(unsent.id),
		"the request that did not reach the socket keeps its place at the front"
	);
}

#[test]
fn an_endpoint_is_what_was_written_or_it_is_a_stated_reason() {
	assert_eq!(
		Endpoint::parse("unix:/run/veyyon/engine.sock"),
		Ok(Endpoint::Unix("/run/veyyon/engine.sock".into()))
	);
	assert_eq!(
		Endpoint::parse("  tcp:127.0.0.1:7654  "),
		Ok(Endpoint::Tcp("127.0.0.1:7654".to_owned())),
		"surrounding space is not part of an address"
	);
	assert_eq!(
		Endpoint::parse("tcp:[::1]:7654"),
		Ok(Endpoint::Tcp("[::1]:7654".to_owned())),
		"an IPv6 authority holds colons of its own"
	);

	assert_eq!(Endpoint::parse("/run/veyyon.sock"), Err(EndpointError::NoScheme));
	assert_eq!(
		Endpoint::parse("http:127.0.0.1:80"),
		Err(EndpointError::UnknownScheme("http".to_owned()))
	);
	assert_eq!(Endpoint::parse("unix:"), Err(EndpointError::Empty("unix")));
	assert_eq!(Endpoint::parse("tcp:"), Err(EndpointError::Empty("tcp")));
	assert_eq!(
		Endpoint::parse("tcp:127.0.0.1"),
		Err(EndpointError::NoPort("127.0.0.1".to_owned())),
		"an authority with no port cannot be connected to"
	);
	assert_eq!(
		Endpoint::parse("tcp:127.0.0.1:hello"),
		Err(EndpointError::NoPort("127.0.0.1:hello".to_owned()))
	);

	for written in ["unix:/run/veyyon/engine.sock", "tcp:127.0.0.1:7654", "tcp:[::1]:7654"] {
		let parsed = Endpoint::parse(written).expect("the address parses");
		assert_eq!(
			parsed.to_string(),
			written,
			"what the reader is shown is what parsed, so the state round-trips"
		);
		assert_eq!(Endpoint::parse(&parsed.to_string()), Ok(parsed));
	}
	assert_eq!(
		Endpoint::parse("unix:/run/veyyon.sock"),
		Ok(Endpoint::Unix("/run/veyyon.sock".into())),
		"a unix endpoint carries the path it was written with"
	);
}
