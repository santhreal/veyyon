//! The announcements raised for something that happened out of view (§5.15).
//!
//! A request that failed, a protocol error that ended the connection and a
//! decision waiting on a session that is not the open one each change nothing
//! the operator is looking at. The queue holds what was raised until it is
//! dismissed or its time is up, keyed so a control that fails four times in a
//! row announces once, ordered so the most urgent announcement is first, and
//! bounded so a failing loop cannot fill the window with cards.

use serde::{Deserialize, Serialize};
use strum::EnumIter;

/// How many announcements the queue holds at once.
///
/// The stack is drawn over the window's own surfaces, so the bound is what
/// fits at the trailing edge under the chrome without reaching the composer
/// band: past that an announcement covers the surface it is announcing about.
pub const CAPACITY: usize = 6;

/// How much an announcement interrupts, which decides both its place in the
/// stack and how long it stays.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, EnumIter, Serialize, Deserialize,
)]
pub enum NotificationPriority {
	/// Something finished. Worth stating, not worth reading.
	Low,
	/// Something failed and the session carries on.
	Normal,
	/// Something failed that the session does not carry on from, or something
	/// the session is waiting on the operator for.
	Urgent,
}

impl NotificationPriority {
	/// How long an announcement of this priority stays before it expires, or
	/// `None` for one that stays until it is dismissed.
	#[must_use]
	pub const fn ttl_ms(self) -> Option<u64> {
		match self {
			Self::Low => Some(4_000),
			Self::Normal => Some(8_000),
			Self::Urgent => None,
		}
	}
}

/// What raised an announcement.
///
/// Every member is something the window reports nowhere else. A fatal
/// protocol error is not one of them: it takes the connection to
/// `ConnectionState::Fatal`, which the titlebar line states and the whole
/// window is repainted for.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, EnumIter, Serialize, Deserialize,
)]
pub enum NotificationSource {
	/// A decision arrived on a session that is not the open one, so the card
	/// that states it is drawn in a transcript nobody is reading.
	DecisionWaiting,
	/// A request the host refused, whose control may not be drawn: a settings
	/// field under a closed sheet, a row in a collapsed queue.
	RequestFailed,
	/// A sound or a desktop notification the operator turned on did not run,
	/// so the announcement it was meant to carry reached the window and
	/// nothing else. This one is never carried anywhere itself, which is what
	/// keeps a broken notifier from announcing its own failure again for
	/// every card.
	DeliveryFailed,
}

impl NotificationSource {
	/// Wire string identifier for this source.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::DecisionWaiting => "decision-waiting",
			Self::RequestFailed => "request-failed",
			Self::DeliveryFailed => "delivery-failed",
		}
	}
}

/// One announcement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
	/// What a second announcement about the same thing merges into. Two
	/// announcements with one key are one announcement.
	pub key:          String,
	pub source:       NotificationSource,
	pub priority:     NotificationPriority,
	/// The one line the stack draws.
	pub title:        String,
	/// What the line left out, drawn under it when there is room.
	pub detail:       Option<String>,
	pub raised_at_ms: u64,
}

impl Notification {
	/// When this announcement expires, or `None` for one that stays.
	#[must_use]
	pub const fn expires_at_ms(&self) -> Option<u64> {
		match self.priority.ttl_ms() {
			Some(ttl) => Some(self.raised_at_ms + ttl),
			None => None,
		}
	}

	/// Whether `now_ms` is at or past the moment this announcement expires.
	#[must_use]
	pub const fn has_expired(&self, now_ms: u64) -> bool {
		match self.expires_at_ms() {
			Some(at) => now_ms >= at,
			None => false,
		}
	}
}

/// What raising an announcement did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raised {
	/// It went on the stack and nothing came off.
	Added,
	/// Something with the same key was already up, and this is the same
	/// announcement stated again.
	Merged,
	/// It went on the stack, and the named key came off to make room.
	Evicted(String),
	/// The stack was full and every announcement on it outranks this one, so
	/// the urgent thing the operator has not read stays drawn.
	Refused,
}

/// The announcements currently raised, most urgent first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationQueue {
	raised: Vec<Notification>,
}

impl NotificationQueue {
	/// An empty queue.
	#[must_use]
	pub const fn new() -> Self {
		Self { raised: Vec::new() }
	}

	/// The announcements on the stack, most urgent first and oldest first
	/// within one priority.
	#[must_use]
	pub fn raised(&self) -> &[Notification] {
		&self.raised
	}

	#[must_use]
	pub const fn len(&self) -> usize {
		self.raised.len()
	}

	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.raised.is_empty()
	}

	/// Whether an announcement under `key` is up.
	#[must_use]
	pub fn holds(&self, key: &str) -> bool {
		self.raised.iter().any(|held| held.key == key)
	}

	/// Raises `notification`, merging it into the announcement that already
	/// holds its key and making room for it under the bound.
	pub fn raise(&mut self, notification: Notification) -> Raised {
		if let Some(held) = self
			.raised
			.iter_mut()
			.find(|held| held.key == notification.key)
		{
			held.priority = held.priority.max(notification.priority);
			held.raised_at_ms = held.raised_at_ms.max(notification.raised_at_ms);
			held.source = notification.source;
			held.title = notification.title;
			held.detail = notification.detail;
			self.order();
			return Raised::Merged;
		}
		let outcome = if self.raised.len() >= CAPACITY {
			let Some(last) = self.raised.last() else {
				return Raised::Refused;
			};
			if last.priority >= notification.priority {
				return Raised::Refused;
			}
			self
				.raised
				.pop()
				.map_or(Raised::Added, |gone| Raised::Evicted(gone.key))
		} else {
			Raised::Added
		};
		self.raised.push(notification);
		self.order();
		outcome
	}

	/// Drops every announcement whose time is up, reporting how many went.
	pub fn expire(&mut self, now_ms: u64) -> usize {
		let before = self.raised.len();
		self.raised.retain(|held| !held.has_expired(now_ms));
		before - self.raised.len()
	}

	/// Drops the announcement under `key`, reporting whether one was up.
	pub fn dismiss(&mut self, key: &str) -> bool {
		let before = self.raised.len();
		self.raised.retain(|held| held.key != key);
		before != self.raised.len()
	}

	/// Drops every announcement whose key starts with `prefix`, reporting how
	/// many went.
	///
	/// One session's waiting decisions share a key prefix, so opening that
	/// session takes down every card about it at once: what is in front of the
	/// operator is not announced to them.
	pub fn dismiss_prefix(&mut self, prefix: &str) -> usize {
		let before = self.raised.len();
		self.raised.retain(|held| !held.key.starts_with(prefix));
		before - self.raised.len()
	}

	/// Drops every announcement.
	pub fn clear(&mut self) {
		self.raised.clear();
	}

	/// The single definition of the stack's order: most urgent first, and the
	/// one that has been up longest first within a priority. The key breaks a
	/// tie so two announcements raised in the same millisecond draw in one
	/// order rather than whichever the sort happened to keep.
	fn order(&mut self) {
		self.raised.sort_by(|left, right| {
			right
				.priority
				.cmp(&left.priority)
				.then(left.raised_at_ms.cmp(&right.raised_at_ms))
				.then(left.key.cmp(&right.key))
		});
	}
}
