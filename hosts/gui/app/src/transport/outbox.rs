//! Intent waiting for a socket.
//!
//! A request is dispatched by a surface, not by the connection, so the two are
//! never in step: the reader presses send while the engine is restarting. The
//! outbox holds what has not been written yet and hands it to whichever writer
//! is current.
//!
//! It is bounded, and the bound reports rather than forgets. Dropping a request
//! silently is the failure this exists to prevent: the surface that dispatched
//! it is waiting for a correlation id that would never come back, so the
//! overflow answers that id with a failure instead.

use std::{
	collections::VecDeque,
	sync::{Condvar, Mutex, mpsc::Sender},
	time::{SystemTime, UNIX_EPOCH},
};

use veyyon_gui_core::{
	host::{HostEvent, HostRequest},
	model::{BackendError, ErrorScope},
};

/// How many requests wait for a writer before the outbox starts refusing.
///
/// A reader can press a control a few times while a connection is down; a
/// thousand queued requests means the engine has been gone long enough that
/// replaying them would act on a state nobody is looking at any more.
pub const MAX_PENDING_REQUESTS: usize = 256;

/// Wall-clock milliseconds, for the timestamp a reported error carries.
pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
		.unwrap_or_default()
}

struct Queue {
	pending:    VecDeque<HostRequest>,
	/// Which connection the current writer belongs to. A writer whose
	/// generation is stale returns rather than writing to a dead socket.
	generation: u64,
	/// Set when a writer may take from the queue.
	writable:   bool,
	stopped:    bool,
}

pub struct Outbox {
	queue:   Mutex<Queue>,
	waiting: Condvar,
	events:  Sender<HostEvent>,
}

impl Outbox {
	pub fn new(events: Sender<HostEvent>) -> Self {
		Self {
			queue: Mutex::new(Queue {
				pending:    VecDeque::new(),
				generation: 0,
				writable:   false,
				stopped:    false,
			}),
			waiting: Condvar::new(),
			events,
		}
	}

	/// Take a request from a surface. Reports the request as failed when the
	/// queue is full, so no correlation id is left unanswered.
	pub fn push(&self, request: HostRequest) {
		let Ok(mut queue) = self.queue.lock() else {
			self.refuse(request, "the transport stopped");
			return;
		};
		if queue.stopped {
			drop(queue);
			self.refuse(request, "the transport stopped");
			return;
		}
		if queue.pending.len() >= MAX_PENDING_REQUESTS {
			drop(queue);
			self.refuse(request, "the engine has been unreachable long enough to fill the queue");
			return;
		}
		queue.pending.push_back(request);
		drop(queue);
		self.waiting.notify_all();
	}

	/// Open a new generation for a connection that has just been made, and
	/// return the token its writer must present.
	pub fn open(&self) -> u64 {
		let Ok(mut queue) = self.queue.lock() else {
			return 0;
		};
		queue.generation = queue.generation.wrapping_add(1);
		queue.writable = true;
		let generation = queue.generation;
		drop(queue);
		self.waiting.notify_all();
		generation
	}

	/// Close the current generation. Anything still queued stays queued for the
	/// next connection.
	pub fn close(&self) {
		if let Ok(mut queue) = self.queue.lock() {
			queue.writable = false;
			queue.generation = queue.generation.wrapping_add(1);
			drop(queue);
			self.waiting.notify_all();
		}
	}

	/// Refuse everything from here on, and answer what is still queued.
	pub fn stop(&self) {
		let drained = match self.queue.lock() {
			Ok(mut queue) => {
				queue.stopped = true;
				queue.writable = false;
				queue.generation = queue.generation.wrapping_add(1);
				queue.pending.drain(..).collect::<Vec<_>>()
			},
			Err(_) => Vec::new(),
		};
		self.waiting.notify_all();
		for request in drained {
			self.refuse(request, "the window closed the connection");
		}
	}

	/// Block until this generation has a request to write, or until the
	/// generation ends.
	pub fn take(&self, generation: u64) -> Option<HostRequest> {
		let mut queue = self.queue.lock().ok()?;
		loop {
			if queue.stopped || queue.generation != generation || !queue.writable {
				return None;
			}
			if let Some(request) = queue.pending.pop_front() {
				return Some(request);
			}
			queue = self.waiting.wait(queue).ok()?;
		}
	}

	/// Put a request back at the front after a failed write, so the next
	/// connection writes it rather than the reader losing it.
	pub fn return_unsent(&self, request: HostRequest) {
		if let Ok(mut queue) = self.queue.lock() {
			if queue.stopped || queue.pending.len() >= MAX_PENDING_REQUESTS {
				drop(queue);
				self.refuse(request, "the engine dropped the connection mid-write");
				return;
			}
			queue.pending.push_front(request);
		}
	}

	/// How many requests are waiting. Nothing that draws reads this; the suite
	/// asserts the bound with it.
	#[cfg(test)]
	pub fn pending(&self) -> usize {
		self
			.queue
			.lock()
			.map(|queue| queue.pending.len())
			.unwrap_or_default()
	}

	fn refuse(&self, request: HostRequest, message: &str) {
		let error = BackendError {
			scope:          ErrorScope::Connection,
			code:           Some("transport-refused".to_owned()),
			message:        message.to_owned(),
			retryable:      true,
			request:        Some(request.id),
			occurred_at_ms: now_ms(),
		};
		let _ = self
			.events
			.send(HostEvent::RequestFailed { request: request.id, error });
	}
}
