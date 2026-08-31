//! A peer that speaks the wire format, for the suites next to this file.
//!
//! Not a stand-in for the session under test: the session connects to this over
//! a real loopback socket, writes real frames to it and reads real frames back.
//! Only the engine's behaviour is scripted, because the engine is the boundary.

use std::{
	io::{BufReader, ErrorKind, Read, Write},
	net::{TcpListener, TcpStream},
	thread::sleep,
	time::{Duration, Instant},
};

use veyyon_gui_core::{
	host::{HostAction, HostEvent, HostRequest},
	model::{ConnectionState, RequestId},
};

use super::{
	endpoint::Endpoint,
	frames,
	session::{Policy, Session},
};
use crate::bridge::Adapter;

/// Long enough that a loopback round trip is never the reason a test fails,
/// short enough that a hang is a failure rather than a wait.
pub const DEADLINE: Duration = Duration::from_secs(5);

/// A backoff small enough to watch two attempts inside one test.
pub fn quick(attempts: Option<u32>) -> Policy {
	Policy {
		first_backoff: Duration::from_millis(20),
		max_backoff: Duration::from_millis(40),
		attempts,
	}
}

/// An address on loopback that refuses immediately. Port 1 is privileged, so
/// nothing in a test environment is listening there and nothing can be.
pub fn nobody() -> Endpoint {
	Endpoint::Tcp("127.0.0.1:1".to_owned())
}

pub fn request(id: u64, action: HostAction) -> HostRequest {
	HostRequest { id: RequestId::new(id).expect("a nonzero correlation id"), action }
}

pub struct Engine {
	listener: TcpListener,
	endpoint: Endpoint,
}

impl Engine {
	pub fn bind() -> Self {
		let listener = TcpListener::bind("127.0.0.1:0").expect("loopback binds");
		let port = listener
			.local_addr()
			.expect("the socket has an address")
			.port();
		listener
			.set_nonblocking(true)
			.expect("the listener polls for a connection");
		Self { listener, endpoint: Endpoint::Tcp(format!("127.0.0.1:{port}")) }
	}

	pub fn endpoint(&self) -> Endpoint {
		self.endpoint.clone()
	}

	/// Take the next connection, or nothing inside `within`.
	pub fn accept(&self, within: Duration) -> Option<Peer> {
		let until = Instant::now() + within;
		loop {
			match self.listener.accept() {
				Ok((stream, _)) => return Some(Peer::hold(stream)),
				Err(error) if error.kind() == ErrorKind::WouldBlock => {
					if Instant::now() >= until {
						return None;
					}
					sleep(Duration::from_millis(2));
				},
				Err(_) => return None,
			}
		}
	}
}

pub struct Peer {
	writer: TcpStream,
	reader: BufReader<TcpStream>,
	buffer: Vec<u8>,
}

impl Peer {
	fn hold(stream: TcpStream) -> Self {
		stream
			.set_nonblocking(false)
			.expect("the accepted socket blocks");
		stream
			.set_read_timeout(Some(DEADLINE))
			.expect("a peer read has a deadline");
		let writer = stream.try_clone().expect("the socket clones");
		Self { writer, reader: BufReader::new(stream), buffer: Vec::new() }
	}

	pub fn send(&mut self, event: &HostEvent) {
		frames::write(&mut self.writer, event).expect("the engine writes a frame");
	}

	/// Write bytes as they are, for a frame no serialiser would produce.
	pub fn write_bytes(&mut self, bytes: &[u8]) {
		self.writer.write_all(bytes).expect("the engine writes");
		self.writer.flush().expect("the engine flushes");
	}

	pub fn greet(&mut self, protocol: u32) {
		self.send(&HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "tcp:127.0.0.1:0".to_owned(),
			protocol,
		}));
	}

	pub fn read_request(&mut self) -> Option<HostRequest> {
		frames::read(&mut self.reader, &mut self.buffer).ok()
	}

	/// Whether the other side has closed. Proves a stopped session releases the
	/// socket rather than leaving a thread parked on it.
	pub fn closed_within(&mut self, within: Duration) -> bool {
		self
			.reader
			.get_ref()
			.set_read_timeout(Some(within))
			.expect("the read has a deadline");
		let mut byte = [0u8; 1];
		matches!(self.reader.get_mut().read(&mut byte), Ok(0))
	}
}

/// Collect events until `until` matches one, or the deadline passes. Every
/// event is kept, so an ordering assertion sees what a coalescing poll of the
/// store would hide.
pub fn events_until(
	session: &mut Session,
	until: impl Fn(&HostEvent) -> bool,
	within: Duration,
) -> Vec<HostEvent> {
	let deadline = Instant::now() + within;
	let mut seen = Vec::new();
	loop {
		match session.next_event() {
			Some(event) => {
				let done = until(&event);
				seen.push(event);
				if done {
					return seen;
				}
			},
			None => {
				if Instant::now() >= deadline {
					return seen;
				}
				sleep(Duration::from_millis(1));
			},
		}
	}
}

/// Only the connection states from a run of events, in the order they arrived.
pub fn states(events: &[HostEvent]) -> Vec<ConnectionState> {
	events
		.iter()
		.filter_map(|event| match event {
			HostEvent::ConnectionChanged(state) => Some(state.clone()),
			_ => None,
		})
		.collect()
}

/// Whether a run of events ever reported a connection.
pub fn ever_connected(states: &[ConnectionState]) -> bool {
	states.iter().any(ConnectionState::is_connected)
}
