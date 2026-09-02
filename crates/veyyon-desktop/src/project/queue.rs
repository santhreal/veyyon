//! The queue's rows: one per session, in the partition the store holds it in.

use veyyon_desktop_model::{QueuePartition, Session, SessionBadge, SessionId, Store};
use veyyon_desktop_surface::{Badge, Row, Section};

/// The session ids in a partition, in the collection's order.
pub(super) fn partition_ids(store: &Store, partition: QueuePartition) -> &[SessionId] {
	let sessions = &store.sessions;
	match partition {
		QueuePartition::Unsent => &sessions.unsent,
		QueuePartition::Pinned => &sessions.pinned,
		QueuePartition::Live => &sessions.live,
		QueuePartition::Deferred => &sessions.deferred,
		QueuePartition::Parked => &sessions.parked,
	}
}

pub(super) const fn section(partition: QueuePartition) -> Section {
	match partition {
		QueuePartition::Unsent => Section::Unsent,
		QueuePartition::Pinned => Section::Pinned,
		QueuePartition::Live => Section::Live,
		QueuePartition::Deferred => Section::Deferred,
		QueuePartition::Parked => Section::Parked,
	}
}

pub(super) const fn badge(badge: &SessionBadge) -> Badge {
	match badge {
		SessionBadge::Approval => Badge::Approval,
		SessionBadge::Input => Badge::Input,
		SessionBadge::Plan => Badge::Plan,
		SessionBadge::Failed => Badge::Failed,
		SessionBadge::Due => Badge::Due,
		SessionBadge::Done => Badge::Done,
		SessionBadge::Working { .. } => Badge::Working,
		SessionBadge::Watching => Badge::Watching,
	}
}

pub(super) fn row(session: &Session, id: u64, now_ms: u64) -> Row {
	let subtitle = if session.branch.is_empty() {
		session.project_name.clone()
	} else {
		format!("{} · {}", session.project_name, session.branch)
	};
	let meta = match (&session.badge, session.defer_until_ms) {
		(Some(SessionBadge::Working { started_at_ms }), _) => {
			Some(elapsed_label(now_ms.saturating_sub(*started_at_ms)))
		},
		(_, Some(due_at_ms)) if due_at_ms > now_ms => {
			Some(format!("in {}", elapsed_label(due_at_ms - now_ms)))
		},
		_ => Some(elapsed_label(now_ms.saturating_sub(session.last_recall_at_ms))),
	};
	Row {
		id,
		title: session.title.clone(),
		subtitle,
		badge: session.badge.as_ref().map(badge),
		meta,
	}
}

/// A duration as the queue shows it: the largest unit that is at least one.
#[must_use]
pub fn elapsed_label(ms: u64) -> String {
	const MINUTE: u64 = 60_000;
	const HOUR: u64 = 60 * MINUTE;
	const DAY: u64 = 24 * HOUR;
	if ms >= DAY {
		format!("{}d", ms / DAY)
	} else if ms >= HOUR {
		format!("{}h", ms / HOUR)
	} else if ms >= MINUTE {
		format!("{}m", ms / MINUTE)
	} else {
		format!("{}s", ms / 1000)
	}
}
