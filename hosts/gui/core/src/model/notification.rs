//! Notification queue, entry replica models, and retention policies.
//!
//! Notifications inform the user of background events, tool completions,
//! connection transitions, and request failures. Entries deduplicate by key,
//! bound their total queue length by evicting the oldest lowest-priority
//! entries first, and auto-expire on frame time unless they represent errors.

use crate::command::UiCommand;

/// Maximum entries retained in the active notification queue before eviction.
pub const MAX_QUEUE_CAPACITY: usize = 50;

/// Default lifetime for non-error notifications in milliseconds.
pub const DEFAULT_EXPIRY_MS: u64 = 5_000;

/// A stable identifier for a single notification instance.
#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct NotificationId(pub String);

impl NotificationId {
	pub fn new(id: impl Into<String>) -> Self {
		Self(id.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// A deduplication key grouping repeated occurrences of an event.
#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct NotificationKey(pub String);

impl NotificationKey {
	pub fn new(key: impl Into<String>) -> Self {
		Self(key.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// Semantic level and intent for a notification.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, serde::Serialize, serde::Deserialize,
)]
pub enum NotificationTone {
	#[default]
	Info,
	Ok,
	Warn,
	Error,
}

impl NotificationTone {
	pub const ALL: [Self; 4] = [Self::Info, Self::Ok, Self::Warn, Self::Error];

	pub const fn is_error(self) -> bool {
		matches!(self, Self::Error)
	}

	pub const fn priority(self) -> u8 {
		match self {
			Self::Ok => 0,
			Self::Info => 1,
			Self::Warn => 2,
			Self::Error => 3,
		}
	}
}

/// User preferences controlling notification delivery and retention.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct NotificationSettings {
	pub sound:          bool,
	pub persist_errors: bool,
}

impl NotificationSettings {
	pub fn parse_setting(key: &str, value: &str) -> Result<Self, String> {
		let mut settings = Self::default();
		match key {
			"sound" => match value.trim().to_lowercase().as_str() {
				"true" | "1" | "on" | "yes" => settings.sound = true,
				"false" | "0" | "off" | "no" => settings.sound = false,
				invalid => return Err(format!("invalid boolean for sound setting: {invalid}")),
			},
			"persist_errors" | "persist-errors" => match value.trim().to_lowercase().as_str() {
				"true" | "1" | "on" | "yes" => settings.persist_errors = true,
				"false" | "0" | "off" | "no" => settings.persist_errors = false,
				invalid => {
					return Err(format!("invalid boolean for persist_errors setting: {invalid}"));
				},
			},
			unknown => return Err(format!("unknown notification setting: {unknown}")),
		}
		Ok(settings)
	}
}

/// One notification entry inside the queue.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Notification {
	pub id:            NotificationId,
	pub key:           NotificationKey,
	pub tone:          NotificationTone,
	pub title:         String,
	pub detail:        Option<String>,
	pub action:        Option<(String, UiCommand)>,
	pub created_at_ms: u64,
	pub expires_at_ms: Option<u64>,
	pub count:         u32,
	pub read:          bool,
}

impl Notification {
	pub fn new(
		id: NotificationId,
		key: NotificationKey,
		tone: NotificationTone,
		title: impl Into<String>,
		created_at_ms: u64,
	) -> Self {
		let expires_at_ms = if tone.is_error() {
			None
		} else {
			Some(created_at_ms.saturating_add(DEFAULT_EXPIRY_MS))
		};
		Self {
			id,
			key,
			tone,
			title: title.into(),
			detail: None,
			action: None,
			created_at_ms,
			expires_at_ms,
			count: 1,
			read: false,
		}
	}

	pub fn detail(mut self, detail: impl Into<String>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn action(mut self, label: impl Into<String>, command: UiCommand) -> Self {
		self.action = Some((label.into(), command));
		self
	}
}

/// The bounded deduplicating notification queue.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct NotificationQueue {
	entries:      Vec<Notification>,
	pub settings: NotificationSettings,
	hover_held:   bool,
	next_id:      u64,
}

impl NotificationQueue {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn entries(&self) -> &[Notification] {
		&self.entries
	}

	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	pub fn len(&self) -> usize {
		self.entries.len()
	}

	pub fn is_hover_held(&self) -> bool {
		self.hover_held
	}

	pub fn set_hover_held(&mut self, held: bool) {
		self.hover_held = held;
	}

	pub fn next_id(&mut self) -> NotificationId {
		let id = self.next_id;
		self.next_id = self.next_id.saturating_add(1);
		NotificationId::new(format!("notification-{id}"))
	}

	/// Insert or deduplicate a notification.
	///
	/// If an entry with the same key exists, updates its count, details, and
	/// timestamp while preserving its identifier. If the queue is at capacity,
	/// evicts the oldest entry with the lowest priority.
	pub fn push(&mut self, entry: Notification) -> NotificationId {
		if let Some(existing) = self.entries.iter_mut().find(|e| e.key == entry.key) {
			existing.count = existing.count.saturating_add(1);
			existing.title = entry.title;
			existing.detail = entry.detail;
			existing.action = entry.action;
			existing.created_at_ms = entry.created_at_ms;
			if entry.tone.priority() >= existing.tone.priority() {
				existing.tone = entry.tone;
			}
			existing.expires_at_ms = if existing.tone.is_error() {
				None
			} else {
				Some(entry.created_at_ms.saturating_add(DEFAULT_EXPIRY_MS))
			};
			existing.read = false;
			return existing.id.clone();
		}

		while self.entries.len() >= MAX_QUEUE_CAPACITY {
			self.evict_lowest_priority();
		}

		let id = entry.id.clone();
		self.entries.push(entry);
		id
	}

	fn evict_lowest_priority(&mut self) {
		if self.entries.is_empty() {
			return;
		}
		let mut lowest_priority = u8::MAX;
		let mut oldest_created = u64::MAX;
		let mut evict_index = 0;

		for (index, entry) in self.entries.iter().enumerate() {
			let priority = entry.tone.priority();
			if priority < lowest_priority
				|| (priority == lowest_priority && entry.created_at_ms < oldest_created)
			{
				lowest_priority = priority;
				oldest_created = entry.created_at_ms;
				evict_index = index;
			}
		}

		self.entries.remove(evict_index);
	}

	/// Dismiss a single notification by id.
	pub fn dismiss(&mut self, id: &NotificationId) -> bool {
		if let Some(index) = self.entries.iter().position(|e| &e.id == id) {
			self.entries.remove(index);
			true
		} else {
			false
		}
	}

	/// Dismiss all notifications currently in the queue.
	pub fn dismiss_all(&mut self) {
		self.entries.clear();
	}

	/// Mark a notification as read, respecting the error persistence setting.
	pub fn mark_read(&mut self, id: &NotificationId) -> bool {
		if let Some(entry) = self.entries.iter_mut().find(|e| &e.id == id) {
			entry.read = true;
			if !entry.tone.is_error() || !self.settings.persist_errors {
				let id_clone = id.clone();
				self.dismiss(&id_clone);
			}
			true
		} else {
			false
		}
	}

	/// Sweep expired entries given current frame time.
	///
	/// Errors never expire. If hover is held, no expiration occurs.
	pub fn sweep(&mut self, now_ms: u64) {
		if self.hover_held {
			return;
		}
		self.entries.retain(|entry| {
			if entry.tone.is_error() {
				return true;
			}
			match entry.expires_at_ms {
				Some(expiry) => now_ms < expiry,
				None => true,
			}
		});
	}
}
