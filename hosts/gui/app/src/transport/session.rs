//! The connection, and the states it reports while it has none.
//!
//! One thread owns the connection: it connects, reads frames until the socket
//! ends, reports why, waits out a backoff, and connects again. A second thread
//! per connection writes what the outbox holds, because a write must not block
//! the frame the window is drawing.
//!
//! Every state a reader sees comes from here and is one of
//! [`ConnectionState`]'s: `Connecting` while a socket is being made,
//! `Reconnecting` with the time the next attempt is due, `Fatal` for a fault
//! that repeating cannot fix, and the engine's own `Connected` once its first
//! frame states a protocol this window speaks. Nothing here invents a snapshot,
//! so a window with no engine draws an empty product rather than a plausible
//! one.

use std::{
	io::BufReader,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
		mpsc::{Receiver, Sender, channel},
	},
	thread,
	time::Duration,
};

use veyyon_gui_core::{
	host::{HostEvent, HostRequest},
	model::ConnectionState,
};

use super::{
	endpoint::Endpoint,
	frames::{self, FrameError},
	outbox::{Outbox, now_ms},
	socket::Socket,
};
use crate::bridge::Adapter;

/// The protocol this window speaks. The engine states its own in the first
/// frame, and a mismatch ends the session rather than half-working.
pub const PROTOCOL: u32 = 1;

/// How long to wait between attempts, and whether to stop attempting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
	pub first_backoff: Duration,
	pub max_backoff:   Duration,
	/// A ceiling on attempts, for a caller that must not retry forever. The
	/// window itself has none: an engine that is restarting comes back.
	pub attempts:      Option<u32>,
}

impl Default for Policy {
	fn default() -> Self {
		Self {
			first_backoff: Duration::from_millis(250),
			max_backoff:   Duration::from_secs(30),
			attempts:      None,
		}
	}
}

/// The current connection's shutdown handle.
///
/// A reader thread parked in `read` cannot see a flag, so stopping is a
/// shutdown on a second handle to the same socket. The slot is empty whenever
/// there is no connection to end.
type Held = Arc<Mutex<Option<Socket>>>;

/// A live connection to an engine, or the attempts to make one.
pub struct Session {
	events:  Receiver<HostEvent>,
	outbox:  Arc<Outbox>,
	stopped: Arc<AtomicBool>,
	held:    Held,
}

impl Session {
	/// Start connecting. Returns at once: the first state arrives as an event.
	pub fn connect(endpoint: Endpoint) -> Self {
		Self::with_policy(endpoint, Policy::default())
	}

	pub fn with_policy(endpoint: Endpoint, policy: Policy) -> Self {
		let (events, inbound) = channel();
		let outbox = Arc::new(Outbox::new(events.clone()));
		let stopped = Arc::new(AtomicBool::new(false));
		let held: Held = Arc::new(Mutex::new(None));
		let worker = Worker {
			endpoint,
			policy,
			events,
			outbox: Arc::clone(&outbox),
			stopped: Arc::clone(&stopped),
			held: Arc::clone(&held),
		};
		thread::Builder::new()
			.name("veyyon-gui-transport".to_owned())
			.spawn(move || worker.run())
			.map(|_| ())
			.unwrap_or_default();
		Self { events: inbound, outbox, stopped, held }
	}

	/// How many requests are waiting for a socket. For the suite.
	#[cfg(test)]
	pub fn pending(&self) -> usize {
		self.outbox.pending()
	}

	/// A session that never connects, holding one state the reader must see.
	///
	/// The endpoint was unusable before a socket was ever attempted, and the
	/// window still has to say so. Intent dispatched into this session is
	/// refused with a failure carrying its correlation id rather than queued
	/// against a connection that will not happen.
	pub fn fatal(message: String) -> Self {
		let (events, inbound) = channel();
		let outbox = Arc::new(Outbox::new(events.clone()));
		outbox.stop();
		let _ = events.send(HostEvent::ConnectionChanged(ConnectionState::Fatal { message }));
		Self {
			events: inbound,
			outbox,
			stopped: Arc::new(AtomicBool::new(true)),
			held: Arc::new(Mutex::new(None)),
		}
	}
}

impl Adapter for Session {
	fn submit(&mut self, request: HostRequest) {
		self.outbox.push(request);
	}

	fn next_event(&mut self) -> Option<HostEvent> {
		self.events.try_recv().ok()
	}
}

impl Drop for Session {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::SeqCst);
		if let Some(socket) = self.held.lock().ok().and_then(|mut slot| slot.take()) {
			socket.shutdown();
		}
		self.outbox.stop();
	}
}

struct Worker {
	endpoint: Endpoint,
	policy:   Policy,
	events:   Sender<HostEvent>,
	outbox:   Arc<Outbox>,
	stopped:  Arc<AtomicBool>,
	held:     Held,
}

impl Worker {
	fn run(self) {
		let mut attempt = 1u32;
		let mut backoff = self.policy.first_backoff;
		loop {
			if self.halted() {
				return;
			}
			if !self.report(ConnectionState::Connecting { attempt }) {
				return;
			}
			let reason = match Socket::connect(&self.endpoint) {
				Ok(socket) => {
					attempt = 1;
					backoff = self.policy.first_backoff;
					match self.serve(socket) {
						Some(fault) if fault.is_protocol_fault() => {
							self.report(ConnectionState::Fatal { message: fault.message() });
							return;
						},
						Some(fault) => fault.message(),
						None => return,
					}
				},
				Err(error) => error.to_string(),
			};
			if self.halted() {
				return;
			}
			if self
				.policy
				.attempts
				.is_some_and(|ceiling| attempt >= ceiling)
			{
				self.report(ConnectionState::Fatal { message: reason });
				return;
			}
			attempt = attempt.saturating_add(1);
			let due = now_ms().saturating_add(u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX));
			if !self.report(ConnectionState::Reconnecting {
				attempt,
				retry_at_ms: due,
				message: reason,
			}) {
				return;
			}
			if !self.wait(backoff) {
				return;
			}
			backoff = (backoff * 2).min(self.policy.max_backoff);
		}
	}

	/// Read frames until the connection ends. `None` means this side stopped.
	fn serve(&self, socket: Socket) -> Option<FrameError> {
		let Ok(writer_socket) = socket.try_clone() else {
			return Some(FrameError::Io(std::io::Error::other("the socket could not be cloned")));
		};
		let Ok(closer) = socket.try_clone() else {
			return Some(FrameError::Io(std::io::Error::other("the socket could not be cloned")));
		};
		let generation = self.outbox.open();
		let outbox = Arc::clone(&self.outbox);
		let writer = thread::Builder::new()
			.name("veyyon-gui-transport-write".to_owned())
			.spawn(move || write_loop(writer_socket, &outbox, generation))
			.ok();
		// Published before the first read: a window closed while this thread is
		// parked in `read` ends the connection through this handle, which is the
		// only thing a parked read notices.
		if let Ok(mut slot) = self.held.lock() {
			*slot = Some(closer);
		}

		let outcome = self.read_loop(socket);

		self.outbox.close();
		if let Some(closer) = self.held.lock().ok().and_then(|mut slot| slot.take()) {
			closer.shutdown();
		}
		if let Some(writer) = writer {
			let _ = writer.join();
		}
		outcome
	}

	fn read_loop(&self, socket: Socket) -> Option<FrameError> {
		let mut source = BufReader::new(socket);
		let mut frame = Vec::new();
		let mut greeted = false;
		loop {
			if self.halted() {
				return None;
			}
			let event: HostEvent = match frames::read(&mut source, &mut frame) {
				Ok(event) => event,
				Err(error) => return Some(error),
			};
			if !greeted {
				match &event {
					HostEvent::ConnectionChanged(ConnectionState::Connected { protocol, .. })
						if *protocol == PROTOCOL =>
					{
						greeted = true
					},
					HostEvent::ConnectionChanged(ConnectionState::Connected { protocol, .. }) => {
						return Some(FrameError::Malformed(format!(
							"the engine speaks protocol {protocol} and this window speaks {PROTOCOL}"
						)));
					},
					_ => {
						return Some(FrameError::Malformed(
							"the engine sent a frame before it stated its protocol".to_owned(),
						));
					},
				}
			}
			if self.events.send(event).is_err() {
				return None;
			}
		}
	}

	/// Sleep in slices so stopping does not wait out a thirty second backoff.
	fn wait(&self, total: Duration) -> bool {
		const SLICE: Duration = Duration::from_millis(50);
		let mut left = total;
		while !left.is_zero() {
			if self.halted() {
				return false;
			}
			let slice = left.min(SLICE);
			thread::sleep(slice);
			left -= slice;
		}
		!self.halted()
	}

	fn halted(&self) -> bool {
		self.stopped.load(Ordering::SeqCst)
	}

	/// `false` when the window is gone, which ends the worker.
	fn report(&self, state: ConnectionState) -> bool {
		self
			.events
			.send(HostEvent::ConnectionChanged(state))
			.is_ok()
	}
}

fn write_loop(mut socket: Socket, outbox: &Outbox, generation: u64) {
	while let Some(request) = outbox.take(generation) {
		if frames::write(&mut socket, &request).is_err() {
			outbox.return_unsent(request);
			socket.shutdown();
			return;
		}
	}
}
