//! The typed events [`AppState`](super::AppState) emits after a batch.

use std::ops::Range;

use veyyon_desktop_model::{RequestId, SessionId, SnapshotSectionKind};

/// One region of the store that a batch of host events, or a local intent,
/// changed.
///
/// A batch emits each distinct event once. A view subscribes to the
/// [`AppState`](super::AppState) entity and calls `cx.notify()` on itself
/// only for the events that concern it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreEvent {
	/// The sidebar listing changed: a session was added, removed, renamed,
	/// read, or moved in activity order. [`AppState::projects`] holds the new
	/// listing.
	///
	/// [`AppState::projects`]: super::AppState::projects
	SessionsChanged,
	/// The session the window shows changed.
	ActiveSessionChanged,
	/// The flat display order of a session's transcript was replaced as a
	/// whole. A list rebuilds its items from
	/// [`AppState::entry_count`](super::AppState::entry_count).
	TranscriptReset {
		/// The session whose transcript was replaced.
		session: SessionId,
	},
	/// Items `range` of the previous flat display order were replaced by
	/// `count` items starting at `range.start`, the arguments of
	/// `ListState::splice`.
	TranscriptSpliced {
		/// The session whose transcript changed.
		session: SessionId,
		/// The replaced items, as indices into the previous display order.
		range:   Range<usize>,
		/// The number of items now at `range.start`.
		count:   usize,
	},
	/// The in-flight assistant message of a session changed or ended.
	StreamingChanged {
		/// The session the host routed the stream to.
		session: SessionId,
	},
	/// The decisions a session waits on were raised or answered.
	InteractionsChanged {
		/// The session the decisions belong to.
		session: SessionId,
	},
	/// A panel-domain snapshot section was replaced.
	DomainChanged(SnapshotSectionKind),
	/// The announcement stack changed.
	NotificationsChanged,
	/// The host connection state changed.
	ConnectionChanged,
	/// The host answered a request.
	RequestFinished {
		/// The request the host answered.
		request: RequestId,
		/// `true` when the host took the request, `false` when it refused it.
		ok:      bool,
	},
	/// A store the window writes to disk changed by a choice made in the
	/// window rather than by a host event: a draft, a panel layout or tab, a
	/// sidebar fold, the appearance or a review thread. The window writes it
	/// one debounce window later.
	Remembered,
	/// An intent was queued. The transport calls
	/// [`AppState::drain_outbox`](super::AppState::drain_outbox).
	OutboxReady,
}
