//! Long-lived timeline state, scroll tracking, and session caches.

use std::collections::{BTreeMap, BTreeSet};

use gpui::{Context, FollowMode, ListAlignment, ListOffset, ListState, px};
use veyyon_gui_core::{
	Store,
	model::{EntryId, SessionId, ToolCallView, ToolId, TranscriptEntry},
};
use veyyon_gui_kit::theme::layout;

use super::logic::{self, FollowEvent, FollowState, RowTransition};
use crate::render::entry::{self, EntryCache};

#[derive(Debug, Clone)]
pub(super) struct SavedViewport {
	pub(super) entry:     Option<EntryId>,
	pub(super) offset:    f32,
	pub(super) following: bool,
}

pub struct Timeline {
	pub(super) list:             ListState,
	pub(super) rows:             Vec<TranscriptEntry>,
	pub(super) entry_cache:      BTreeMap<EntryId, EntryCache>,
	pub(super) tools:            BTreeMap<ToolId, ToolCallView>,
	pub(super) open_tools:       BTreeSet<ToolId>,
	pub(super) session:          Option<SessionId>,
	pub(super) saved:            BTreeMap<SessionId, SavedViewport>,
	pub(super) pending_viewport: Option<SavedViewport>,
	pub(super) source_revision:  Option<u64>,
	pub(super) stream_revision:  Option<u64>,
	pub(super) tool_revision:    Option<u64>,
	pub(super) streaming_entry:  Option<EntryId>,
	pub(super) stale_partial:    bool,
	pub follow:                  FollowState,
}

impl Timeline {
	pub fn new(cx: &mut Context<Self>) -> Self {
		let list = ListState::new(0, ListAlignment::Top, px(layout::row_tall()));
		list.set_follow_mode(FollowMode::Tail);
		let weak = cx.weak_entity();
		list.set_scroll_handler(move |_, _, cx| {
			let weak = weak.clone();
			cx.defer(move |cx| {
				weak
					.update(cx, |timeline, cx| {
						let at_end = timeline.list.is_scrolled_to_end().unwrap_or_else(|| {
							timeline.list.logical_scroll_top().item_ix >= timeline.rows.len()
						});
						if at_end {
							timeline.follow.apply(FollowEvent::ReachedEnd);
							timeline.list.set_follow_mode(FollowMode::Tail);
						} else {
							timeline.follow.apply(FollowEvent::UserMovedAway);
						}
						cx.notify();
					})
					.ok();
			});
		});
		Self {
			list,
			rows: Vec::new(),
			entry_cache: BTreeMap::new(),
			tools: BTreeMap::new(),
			open_tools: BTreeSet::new(),
			session: None,
			saved: BTreeMap::new(),
			pending_viewport: None,
			source_revision: None,
			stream_revision: None,
			tool_revision: None,
			streaming_entry: None,
			stale_partial: false,
			follow: FollowState::default(),
		}
	}

	pub(super) fn sync(&mut self, store: &Store) {
		self.switch_session(store.frontend.selected_session.clone());
		if self.session.is_none() {
			return;
		}
		self.open_tools.clone_from(&store.frontend.tool_disclosures);
		let replica_stale = matches!(
			&store.replica.transcript,
			veyyon_gui_core::model::RemoteData::Stale { .. }
				| veyyon_gui_core::model::RemoteData::Error { stale: Some(_), .. }
		);

		if let Some(tools) = store.replica.tools.readable()
			&& self.tool_revision != Some(tools.revision)
		{
			self.tools.clear();
			self.tools.extend(
				tools
					.value
					.iter()
					.cloned()
					.map(|tool| (tool.id.clone(), tool)),
			);
			self.tool_revision = Some(tools.revision);
		}

		if store.replica.transcript.readable().is_none()
			&& matches!(&store.replica.transcript, veyyon_gui_core::model::RemoteData::Empty)
		{
			if let Some(stream) = &store.replica.streaming
				&& self.stream_revision != Some(stream.revision)
			{
				let mut accumulating = stream.accumulating.clone();
				accumulating.revision = stream.revision;
				self.streaming_entry = Some(stream.entry.clone());
				self.stale_partial = !store.connection.is_connected() || replica_stale;
				self.replace_rows(vec![accumulating]);
				self.stream_revision = Some(stream.revision);
			}
			return;
		}
		let Some(transcript) = store.replica.transcript.readable() else {
			return;
		};
		let stream_revision = store
			.replica
			.streaming
			.as_ref()
			.map(|stream| stream.revision);
		if self.source_revision == Some(transcript.revision)
			&& self.stream_revision == stream_revision
		{
			self.stale_partial = store.replica.streaming.is_some()
				&& (!store.connection.is_connected() || replica_stale);
			return;
		}

		let mut rows = transcript.value.clone();
		self.streaming_entry = store
			.replica
			.streaming
			.as_ref()
			.map(|stream| stream.entry.clone());
		if let Some(stream) = &store.replica.streaming {
			let mut accumulating = stream.accumulating.clone();
			accumulating.revision = stream.revision;
			if let Some(index) = rows.iter().position(|entry| entry.id == stream.entry) {
				rows[index] = accumulating;
			} else {
				rows.push(accumulating);
			}
		}
		self.stale_partial =
			store.replica.streaming.is_some() && (!store.connection.is_connected() || replica_stale);
		self.replace_rows(rows);
		self.source_revision = Some(transcript.revision);
		self.stream_revision = stream_revision;
	}

	fn switch_session(&mut self, session: Option<SessionId>) {
		if self.session == session {
			return;
		}
		if let Some(current) = &self.session {
			self.saved.insert(current.clone(), self.viewport());
		}
		self.session = session.clone();
		self.rows.clear();
		self.entry_cache.clear();
		self.source_revision = None;
		self.stream_revision = None;
		self.streaming_entry = None;
		self.list.reset(0);
		self.pending_viewport = session.and_then(|session| self.saved.get(&session).cloned());
		if let Some(saved) = &self.pending_viewport {
			self.follow.following = saved.following;
			self.follow.unseen = 0;
		}
	}

	fn viewport(&self) -> SavedViewport {
		let offset = self.list.logical_scroll_top();
		SavedViewport {
			entry:     self.rows.get(offset.item_ix).map(|entry| entry.id.clone()),
			offset:    f32::from(offset.offset_in_item),
			following: self.follow.following,
		}
	}

	fn replace_rows(&mut self, rows: Vec<TranscriptEntry>) {
		let old_len = self.rows.len();
		let anchor = self.viewport();
		let transition = logic::row_transition(&self.rows, &rows);

		match transition {
			RowTransition::Prefix { appended } => {
				for (index, (old, new)) in self.rows.iter().zip(rows.iter()).enumerate() {
					if old.revision != new.revision {
						self.list.remeasure_items(index..index + 1);
					}
				}
				if appended > 0 {
					self.list.splice(old_len..old_len, appended);
				}
				self.follow.apply(FollowEvent::Appended(appended));
			},
			RowTransition::Prepend { prepended } => {
				if prepended > 0 {
					self.list.splice(0..0, prepended);
				}
				for (index, (old, new)) in self
					.rows
					.iter()
					.zip(rows.iter().skip(prepended))
					.enumerate()
				{
					if old.revision != new.revision {
						self
							.list
							.remeasure_items(index + prepended..index + prepended + 1);
					}
				}
			},
			RowTransition::Reset => {
				self.list.reset(rows.len());
			},
		}

		self.rows = rows;
		self.refresh_caches();
		if let Some(saved) = self.pending_viewport.take() {
			self.restore(saved);
		} else if matches!(transition, RowTransition::Reset) {
			self.restore(anchor);
		}
		if self.follow.following {
			self.list.set_follow_mode(FollowMode::Tail);
		}
	}

	fn refresh_caches(&mut self) {
		let live: BTreeSet<EntryId> = self.rows.iter().map(|entry| entry.id.clone()).collect();
		self.entry_cache.retain(|id, _| live.contains(id));
		for value in &self.rows {
			let rebuild = self
				.entry_cache
				.get(&value.id)
				.is_none_or(|cache| !entry::cache_is_current(cache, value));
			if rebuild {
				self
					.entry_cache
					.insert(entry::cache_key(value), EntryCache::build(value));
			}
		}
	}

	fn restore(&mut self, viewport: SavedViewport) {
		self.follow.following = viewport.following;
		self.follow.unseen = 0;
		if viewport.following {
			self.list.set_follow_mode(FollowMode::Tail);
		} else if let Some(entry) = viewport.entry
			&& let Some(index) = self.rows.iter().position(|row| row.id == entry)
		{
			self
				.list
				.scroll_to(ListOffset { item_ix: index, offset_in_item: px(viewport.offset) });
		}
	}

	pub fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
		self.follow.apply(FollowEvent::JumpToLatest);
		self.list.set_follow_mode(FollowMode::Tail);
		cx.notify();
	}

	/// Show the oldest row the transcript holds, and stop following the tail.
	///
	/// Following has to end here rather than waiting for the list's scroll
	/// handler: tail mode would pull the viewport back to the newest row on the
	/// next append, so the jump would last until the next event.
	pub fn jump_to_oldest(&mut self, cx: &mut Context<Self>) {
		self.follow.apply(FollowEvent::UserMovedAway);
		self.list.set_follow_mode(FollowMode::Normal);
		self
			.list
			.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
		cx.notify();
	}
}
