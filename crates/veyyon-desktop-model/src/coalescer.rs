use std::collections::HashMap;

use thiserror::Error;

use crate::{connection::EntryId, event::HostEvent};

/// Error returned when the event queue rejects an event due to saturation.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EventCoalescerError {
	#[error("event queue capacity exceeded")]
	QueueFull,
}

/// Buffer queuing incoming host events off-thread and folding batches before UI
/// frame render.
#[derive(Debug)]
pub struct EventCoalescer {
	queue:    Vec<HostEvent>,
	capacity: usize,
}

impl Default for EventCoalescer {
	fn default() -> Self {
		Self::new(4096)
	}
}

impl EventCoalescer {
	/// Creates an event coalescer with a fixed queue capacity.
	#[must_use]
	pub fn new(capacity: usize) -> Self {
		Self { queue: Vec::with_capacity(capacity), capacity }
	}

	/// Pushes an incoming event into the queue. A saturated queue is folded
	/// first, which supersedes intermediate streaming states and merges
	/// streaming appends without losing text; it rejects the event only when
	/// the folded queue is still full.
	pub fn push(&mut self, event: HostEvent) -> Result<(), EventCoalescerError> {
		if self.queue.len() >= self.capacity {
			self.queue = Self::fold(std::mem::take(&mut self.queue));
			if self.queue.len() >= self.capacity {
				return Err(EventCoalescerError::QueueFull);
			}
		}
		self.queue.push(event);
		Ok(())
	}

	/// Drains the queue and returns a folded batch of events ready for reducer
	/// execution.
	pub fn drain_frame(&mut self) -> Vec<HostEvent> {
		if self.queue.is_empty() {
			return Vec::new();
		}
		let raw_events = std::mem::replace(&mut self.queue, Vec::with_capacity(self.capacity));
		Self::fold(raw_events)
	}

	/// Returns true if no events are queued.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.queue.is_empty()
	}

	/// Returns the number of events currently queued.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.queue.len()
	}

	/// Folds a batch into the fewest events that reduce to the same store:
	/// each streaming entry keeps its newest whole state with every later
	/// append applied to it, consecutive appends to one block become one,
	/// and connection and transcript updates keep their newest value.
	pub fn fold(events: Vec<HostEvent>) -> Vec<HostEvent> {
		let mut folded: Vec<HostEvent> = Vec::with_capacity(events.len());
		let mut latest_streaming: HashMap<Option<EntryId>, usize> = HashMap::new();
		let mut latest_connection: Option<usize> = None;

		for event in events {
			match &event {
				HostEvent::StreamingChanged(stream) => {
					let key = stream.as_ref().map(|s| s.entry.clone());
					if let Some(&idx) = latest_streaming.get(&key) {
						if let Some(target) = folded.get_mut(idx) {
							*target = event;
						}
					} else {
						let idx = folded.len();
						latest_streaming.insert(key, idx);
						folded.push(event);
					}
				},
				HostEvent::StreamingAppended(append) => {
					let key = Some(append.entry.clone());
					let merged = match latest_streaming
						.get(&key)
						.and_then(|&idx| folded.get_mut(idx))
					{
						// An append that does not fit the held state stays an
						// event of its own, so the reducer reports the mismatch.
						Some(HostEvent::StreamingChanged(Some(state))) => state.append(append).is_ok(),
						Some(HostEvent::StreamingAppended(held)) if held.block == append.block => {
							held.text.push_str(&append.text);
							held.revision = append.revision;
							true
						},
						_ => false,
					};
					if !merged {
						latest_streaming.insert(key, folded.len());
						folded.push(event);
					}
				},
				HostEvent::TranscriptUpdated { entry, .. } => {
					let entry_id = &entry.id;
					if let Some(pos) = folded.iter().rposition(|e| match e {
						HostEvent::TranscriptUpdated { entry: existing, .. } => &existing.id == entry_id,
						_ => false,
					}) {
						if let Some(target) = folded.get_mut(pos) {
							*target = event;
						}
					} else {
						folded.push(event);
					}
				},
				HostEvent::ConnectionChanged(_) => {
					if let Some(idx) = latest_connection {
						if let Some(target) = folded.get_mut(idx) {
							*target = event;
						}
					} else {
						let idx = folded.len();
						latest_connection = Some(idx);
						folded.push(event);
					}
				},
				_ => {
					folded.push(event);
				},
			}
		}
		folded
	}
}
