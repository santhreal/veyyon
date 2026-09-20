//! The queue's rows: one per session, in the partition the store holds it in,
//! under the derived `Unsent` section the drafts produce.

use std::collections::{HashMap, HashSet};

use veyyon_desktop_model::{
	QueuePartition, Session, SessionBadge, SessionId, Store, session_badge,
};
use veyyon_desktop_surface::{Badge, Row, Section};

use super::SessionIndex;

/// The session ids in a partition, in the collection's order.
pub(super) fn partition_ids(store: &Store, partition: QueuePartition) -> &[SessionId] {
	let sessions = &store.sessions;
	match partition {
		QueuePartition::Pinned => &sessions.pinned,
		QueuePartition::Live => &sessions.live,
		QueuePartition::Deferred => &sessions.deferred,
		QueuePartition::Parked => &sessions.parked,
	}
}

pub(super) const fn section(partition: QueuePartition) -> Section {
	match partition {
		QueuePartition::Pinned => Section::Pinned,
		QueuePartition::Live => Section::Live,
		QueuePartition::Deferred => Section::Deferred,
		QueuePartition::Parked => Section::Parked,
	}
}

/// Whether a session holds a prompt that was composed and not submitted (§0).
///
/// The draft belongs to the session it was typed into, and the rail states it
/// once the operator has left that session. The row for the session they are
/// typing in stays in its own partition: §5.2 re-orders the rail on unpark,
/// recall and pin alone, so a keystroke moving a row into another section is
/// the one thing the rail must not do while it is being read.
///
/// Only a session in play is lifted. A parked or deferred session was set
/// aside deliberately, and leftover draft text is no reason to pull it back to
/// the top of the rail; its draft comes back with it when it is unparked or
/// recalled. That also keeps the two hover actions a row offers (§5.2) the
/// ones its placement means: park and defer on a card, unpark or recall on a
/// line.
pub(super) fn holds_unsent_draft(
	store: &Store,
	active: Option<&SessionId>,
	id: &SessionId,
) -> bool {
	active != Some(id)
		&& store.sessions.get(id).is_some_and(|session| {
			matches!(session.partition, QueuePartition::Pinned | QueuePartition::Live)
		}) && store
		.persisted
		.composer
		.get(id)
		.is_some_and(|composer| !composer.draft_text.trim().is_empty())
}

/// The `Unsent` section's sessions, newest first (§0).
///
/// A draft under an id the host no longer lists is not a row: the session is
/// gone and its text goes with it, so the strip states nothing rather than a
/// title the store cannot resolve.
pub(super) fn unsent_ids(store: &Store, active: Option<&SessionId>) -> Vec<SessionId> {
	let mut ids: Vec<SessionId> = store
		.persisted
		.composer
		.keys()
		.filter(|id| holds_unsent_draft(store, active, id))
		.cloned()
		.collect();
	let items = &store.sessions.items;
	ids.sort_by(|a, b| {
		let created_a = items.get(a).map_or(0, |session| session.created_at_ms);
		let created_b = items.get(b).map_or(0, |session| session.created_at_ms);
		created_b.cmp(&created_a).then_with(|| a.cmp(b))
	});
	ids
}

/// Drops the draft the window remembers for the session a row stands for,
/// once the host has taken it (§8.10).
///
/// The `Unsent` section is derived from a retained draft, so a prompt that was
/// sent has to leave the store as well as the composer. The composer clears
/// itself only while it is still the session on screen, and a request is
/// answered after the operator has moved to another session often enough that
/// the store is the authority: without this, a session that has already sent
/// its prompt stands under `Unsent` stating text nobody can retract.
///
/// A row the index never minted, and a session with nothing recorded, clear
/// nothing.
pub fn clear_sent_draft(store: &mut Store, index: &SessionIndex, row: u64) {
	let Some(id) = index.session_of(row).cloned() else {
		return;
	};
	if let Some(composer) = store.persisted.composer.get_mut(&id) {
		composer.draft_text.clear();
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

/// The parent links the sessions of one partition form.
///
/// Built once for the partition and read by every row in it. A row that
/// resolved its own depth and its own children walked the partition twice
/// over, allocating a path map per row: a rail of a thousand sessions cost a
/// million lookups and a thousand maps on every host event, and the rail is
/// projected on every event.
pub(super) struct Hierarchy<'a> {
	/// The session each occupied path stands for.
	by_path: HashMap<&'a str, &'a Session>,
	/// Every path a session in this partition names as its parent.
	parents: HashSet<&'a str>,
}

impl<'a> Hierarchy<'a> {
	/// The links `ids` form, in one pass over them.
	pub(super) fn of(store: &'a Store, ids: &'a [SessionId]) -> Self {
		let mut by_path: HashMap<&'a str, &'a Session> = HashMap::with_capacity(ids.len());
		let mut parents: HashSet<&'a str> = HashSet::with_capacity(ids.len());
		for session in ids.iter().filter_map(|id| store.sessions.get(id)) {
			if !session.path.is_empty() {
				by_path.entry(session.path.as_str()).or_insert(session);
			}
			if let Some(parent) = session.parent_path.as_deref() {
				parents.insert(parent);
			}
		}
		Self { by_path, parents }
	}

	/// How deep a session sits, zero at a root.
	///
	/// A chain longer than the partition is a cycle in the paths the host
	/// sent, which ends the walk rather than hanging the projection.
	fn depth(&self, session: &Session) -> usize {
		let mut depth = 0;
		let mut current = session;
		while let Some(parent) = current
			.parent_path
			.as_deref()
			.and_then(|path| self.by_path.get(path).copied())
		{
			depth += 1;
			if depth > self.by_path.len() {
				break;
			}
			current = parent;
		}
		depth
	}

	/// Whether any session in the partition sits under this one.
	fn holds_children(&self, session: &Session) -> bool {
		!session.path.is_empty() && self.parents.contains(session.path.as_str())
	}
}

/// One session's row, with the badge the host's state derives (§0).
pub(super) fn row(
	store: &Store,
	session: &Session,
	id: u64,
	hierarchy: &Hierarchy<'_>,
	now_ms: u64,
) -> Row {
	let subtitle = if session.branch.is_empty() {
		session.project_name.clone()
	} else {
		format!("{} · {}", session.project_name, session.branch)
	};
	let derived = session_badge(store, &session.id, now_ms);
	let depth = hierarchy.depth(session);
	let is_parent = hierarchy.holds_children(session);
	let collapsed = !session.path.is_empty()
		&& store
			.persisted
			.shell
			.navigation
			.active()
			.queue
			.collapsed_parents
			.contains(&session.path);
	Row {
		id,
		title: session.title.clone(),
		subtitle,
		badge: derived.as_ref().map(badge),
		meta: Some(row_meta(session, derived.as_ref(), now_ms)),
		placement: section(session.partition),
		depth,
		is_parent,
		collapsed,
		path: session.path.clone(),
		parent_path: session.parent_path.clone(),
	}
}

/// Calculates the time metadata string for a session row at `now_ms`.
#[must_use]
pub(super) fn row_meta(session: &Session, derived: Option<&SessionBadge>, now_ms: u64) -> String {
	match (derived, session.defer_until_ms) {
		(Some(SessionBadge::Working { started_at_ms }), _) => {
			elapsed_label(now_ms.saturating_sub(*started_at_ms))
		},
		(_, Some(due_at_ms)) if due_at_ms > now_ms => {
			format!("in {}", elapsed_label(due_at_ms - now_ms))
		},
		_ => elapsed_label(now_ms.saturating_sub(session.last_recall_at_ms)),
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
