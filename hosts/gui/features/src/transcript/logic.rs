//! Pure timeline state, row transitions, and end-follow tracking.

use veyyon_gui_core::model::{ConnectionState, RemoteData, StaleReason, Versioned};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceState<'a, T> {
	Loading { received: Option<u64>, expected: Option<u64> },
	Empty,
	Ready { value: &'a T, stale: Option<&'a StaleReason>, error: Option<(&'a str, bool)> },
	Unavailable { message: &'a str, retryable: bool },
	Fatal { message: &'a str },
}

pub fn surface<'a, T>(
	connection: &'a ConnectionState,
	data: &'a RemoteData<Versioned<T>>,
) -> SurfaceState<'a, T> {
	if let ConnectionState::Fatal { message } = connection {
		return SurfaceState::Fatal { message };
	}
	match data {
		RemoteData::Unrequested => SurfaceState::Empty,
		RemoteData::Loading { .. } => match connection {
			ConnectionState::Syncing { received, expected } => {
				SurfaceState::Loading { received: Some(*received), expected: *expected }
			},
			_ => SurfaceState::Loading { received: None, expected: None },
		},
		RemoteData::Ready(versioned) => {
			SurfaceState::Ready { value: &versioned.value, stale: None, error: None }
		},
		RemoteData::Empty => SurfaceState::Empty,
		RemoteData::Stale { value, reason } => {
			SurfaceState::Ready { value: &value.value, stale: Some(reason), error: None }
		},
		RemoteData::Error { message, retryable, stale: Some(value) } => SurfaceState::Ready {
			value: &value.value,
			stale: None,
			error: Some((message, *retryable)),
		},
		RemoteData::Error { message, retryable, stale: None } => {
			SurfaceState::Unavailable { message, retryable: *retryable }
		},
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FollowState {
	pub following: bool,
	pub unseen:    usize,
}

impl Default for FollowState {
	fn default() -> Self {
		Self { following: true, unseen: 0 }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowEvent {
	UserMovedAway,
	ReachedEnd,
	Appended(usize),
	JumpToLatest,
}

impl FollowState {
	pub fn apply(&mut self, event: FollowEvent) {
		match event {
			FollowEvent::UserMovedAway => self.following = false,
			FollowEvent::ReachedEnd | FollowEvent::JumpToLatest => {
				self.following = true;
				self.unseen = 0;
			},
			FollowEvent::Appended(count) if !self.following => {
				self.unseen = self.unseen.saturating_add(count);
			},
			FollowEvent::Appended(_) => {},
		}
	}

	pub fn show_jump(self) -> bool {
		!self.following && self.unseen > 0
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowTransition {
	Prefix { appended: usize },
	Prepend { prepended: usize },
	Reset,
}

pub trait HasEntryId {
	fn entry_id(&self) -> &str;
}

impl HasEntryId for veyyon_gui_core::model::TranscriptEntry {
	fn entry_id(&self) -> &str {
		self.id.as_str()
	}
}

impl HasEntryId for &str {
	fn entry_id(&self) -> &str {
		self
	}
}

impl HasEntryId for String {
	fn entry_id(&self) -> &str {
		self
	}
}

pub fn row_transition<T: HasEntryId>(old: &[T], new: &[T]) -> RowTransition {
	let old_len = old.len();
	let new_len = new.len();
	if old_len <= new_len
		&& old
			.iter()
			.zip(new.iter())
			.all(|(a, b)| a.entry_id() == b.entry_id())
	{
		RowTransition::Prefix { appended: new_len - old_len }
	} else if old_len <= new_len
		&& old
			.iter()
			.zip(new.iter().skip(new_len - old_len))
			.all(|(a, b)| a.entry_id() == b.entry_id())
	{
		RowTransition::Prepend { prepended: new_len - old_len }
	} else {
		RowTransition::Reset
	}
}

pub fn loading_progress(received: Option<u64>, expected: Option<u64>) -> String {
	match (received, expected) {
		(Some(received), Some(expected)) => format!("{received} of {expected} entries received"),
		(Some(received), None) => format!("{received} entries received"),
		_ => "Waiting for the transcript snapshot".to_owned(),
	}
}
