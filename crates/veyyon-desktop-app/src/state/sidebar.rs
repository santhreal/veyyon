//! What the sidebar keeps in the store: the placement it moves a session to
//! (pinned, deferred, archived or back among its project's threads), and the
//! sections and branches it folds, persisted with the rest of the window's
//! state. The host never sees either.

use veyyon_desktop_model::{QueuePartition, SessionId};
use veyyon_gpui::Context;

use super::{AppState, StoreEvent};

impl AppState {
	/// The partition `session` is placed in, `Live` for a session the store
	/// does not list.
	pub fn partition(&self, session: &SessionId) -> QueuePartition {
		self
			.store
			.sessions
			.get(session)
			.map_or(QueuePartition::Live, |listed| listed.partition)
	}

	/// Places `session` in `to` at `now_ms` and emits
	/// [`StoreEvent::SessionsChanged`]. A session already there, or one the
	/// store does not list, changes nothing.
	pub fn place_session(
		&mut self,
		session: &SessionId,
		to: QueuePartition,
		now_ms: u64,
		cx: &mut Context<Self>,
	) {
		let Some(from) = self
			.store
			.sessions
			.get(session)
			.map(|listed| listed.partition)
		else {
			return;
		};
		if from == to {
			return;
		}
		let sessions = &mut self.store.sessions;
		match (to, from) {
			(QueuePartition::Pinned, _) => sessions.pin(session, None),
			(QueuePartition::Deferred, _) => sessions.defer(session, None),
			(QueuePartition::Parked, _) => sessions.park(session, now_ms),
			(QueuePartition::Live, QueuePartition::Pinned) => sessions.unpin(session, now_ms),
			(QueuePartition::Live, QueuePartition::Deferred) => sessions.recall(session, now_ms),
			(QueuePartition::Live, QueuePartition::Parked | QueuePartition::Live) => {
				sessions.unpark(session, now_ms);
			},
		}
		cx.emit(StoreEvent::SessionsChanged);
	}

	/// Whether the sidebar block recorded as `key` is collapsed.
	pub fn is_section_collapsed(&self, key: &str) -> bool {
		self.store.persisted.queue.collapsed_sections.contains(key)
	}

	/// Collapses the sidebar block recorded as `key`, or expands it when
	/// collapsed.
	pub fn toggle_section(&mut self, key: &str, cx: &mut Context<Self>) {
		self.remember(cx, |persisted| {
			let collapsed = &mut persisted.queue.collapsed_sections;
			if !collapsed.remove(key) {
				collapsed.insert(key.to_owned());
			}
		});
	}

	/// Whether the threads of the project at `path` are hidden.
	pub fn is_project_collapsed(&self, path: &str) -> bool {
		self
			.store
			.persisted
			.queue
			.collapsed_sections
			.iter()
			.any(|key| key.strip_prefix(PROJECT_KEY) == Some(path))
	}

	/// Hides the threads of the project at `path`, or shows them when hidden.
	/// The store records the project beside the blocks, prefixed so that no
	/// path reads as a block.
	pub fn toggle_project(&mut self, path: &str, cx: &mut Context<Self>) {
		self.toggle_section(&format!("{PROJECT_KEY}{path}"), cx);
	}

	/// The pages of archived threads the sidebar lists, at least one.
	pub fn archived_pages(&self) -> usize {
		usize::try_from(self.store.persisted.queue.parked_page.max(1)).unwrap_or(usize::MAX)
	}

	/// Lists `pages` pages of archived threads, never fewer than it lists.
	pub fn list_archived_pages(&mut self, pages: usize, cx: &mut Context<Self>) {
		self.remember(cx, |persisted| {
			let page = &mut persisted.queue.parked_page;
			*page = (*page).max(u32::try_from(pages).unwrap_or(u32::MAX));
		});
	}

	/// Whether the branches listed under `session` are folded, which the
	/// store records by the session's file.
	pub fn are_branches_folded(&self, session: &SessionId) -> bool {
		self.store.sessions.get(session).is_some_and(|listed| {
			!listed.path.is_empty()
				&& self
					.store
					.persisted
					.queue
					.collapsed_parents
					.contains(&listed.path)
		})
	}

	/// Folds the branches under `session`, or unfolds them. A session the
	/// store does not list, or one with no file, changes nothing.
	pub fn toggle_branches(&mut self, session: &SessionId, cx: &mut Context<Self>) {
		let Some(path) = self
			.store
			.sessions
			.get(session)
			.filter(|listed| !listed.path.is_empty())
			.map(|listed| listed.path.clone())
		else {
			return;
		};
		self.remember(cx, |persisted| {
			let folded = &mut persisted.queue.collapsed_parents;
			if !folded.remove(&path) {
				folded.insert(path);
			}
		});
	}
}

/// The prefix a project's path is recorded under among the collapsed blocks.
const PROJECT_KEY: &str = "project:";
