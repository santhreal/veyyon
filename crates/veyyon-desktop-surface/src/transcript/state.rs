//! Retained viewport state for the session transcript (§5.2, §5.3).

mod motion;

use std::{
	cell::RefCell,
	collections::{HashMap, HashSet},
	rc::Rc,
	time::Instant,
};

use veyyon_desktop_motion::{CaretMotion, MotionTokens, RevealMotion, ScrollMotion, SurfaceId};
use veyyon_gpui::{FocusHandle, FollowMode, ListAlignment, ListOffset, ListState, px};

pub use super::session_store::BlockKey;
use super::{fingerprint::compute_turn_fingerprint, session_store::SessionTranscriptStore};
use crate::model::Turn;

struct TranscriptViewportStateInner {
	session_id:             Option<u64>,
	list_state:             ListState,
	focus:                  Option<FocusHandle>,
	turns:                  Rc<[Turn]>,
	store:                  SessionTranscriptStore,
	expanded_blocks:        HashSet<BlockKey>,
	scroll_motion:          ScrollMotion,
	caret_motion:           CaretMotion,
	reveal_motions:         HashMap<BlockKey, RevealMotion>,
	reveal_heights:         HashMap<BlockKey, f32>,
	pending_remeasure:      HashSet<usize>,
	scroll_expected_px:     Option<f32>,
	scroll_follow_end:      bool,
	turn_count:             usize,
	is_streaming:           bool,
	bottom_inset_px:        f32,
	last_turn_fingerprints: Vec<u64>,
	last_focused_turn:      Option<usize>,
}

/// Shared, cloneable handle to the retained transcript viewport state.
#[derive(Clone)]
pub struct TranscriptViewportState(Rc<RefCell<TranscriptViewportStateInner>>);

impl Default for TranscriptViewportState {
	fn default() -> Self {
		Self::new()
	}
}

impl TranscriptViewportState {
	/// Creates a new transcript viewport state at rest with tail following
	/// enabled.
	#[must_use]
	pub fn new() -> Self {
		let list_state = ListState::new(0, ListAlignment::Bottom, px(200.0));
		list_state.set_follow_mode(FollowMode::Tail);

		let inner = TranscriptViewportStateInner {
			session_id: None,
			list_state,
			focus: None,
			turns: Rc::from([]),
			store: SessionTranscriptStore::new(),
			expanded_blocks: HashSet::new(),
			scroll_motion: ScrollMotion::new(SurfaceId::Transcript, 0, 0.0),
			caret_motion: CaretMotion::new(SurfaceId::Transcript, 0),
			reveal_motions: HashMap::new(),
			reveal_heights: HashMap::new(),
			pending_remeasure: HashSet::new(),
			scroll_expected_px: None,
			scroll_follow_end: false,
			turn_count: 0,
			is_streaming: false,
			bottom_inset_px: 0.0,
			last_turn_fingerprints: Vec::new(),
			last_focused_turn: None,
		};

		let state = Self(Rc::new(RefCell::new(inner)));
		state.observe_scroll();
		state
	}

	/// Switches the active session, restoring scroll offset and expansion state
	/// for `session_id`.
	pub fn switch_session(&self, new_session_id: u64, turn_count: usize) {
		let mut inner = self.0.borrow_mut();
		if inner.session_id == Some(new_session_id) {
			return;
		}

		if let Some(old_id) = inner.session_id {
			let current_offset = inner.list_state.logical_scroll_top();
			let blocks = inner.expanded_blocks.clone();
			inner.store.save_session(old_id, current_offset, blocks);
		}

		inner.session_id = Some(new_session_id);
		inner.turn_count = turn_count;
		inner.turns = Rc::from([]);
		inner.last_turn_fingerprints.clear();
		inner.last_focused_turn = None;
		inner.reveal_motions.clear();
		inner.reveal_heights.clear();
		inner.pending_remeasure.clear();
		inner.scroll_expected_px = None;
		inner.scroll_follow_end = false;
		inner.scroll_motion = ScrollMotion::new(SurfaceId::Transcript, 0, 0.0);

		let (saved_offset, blocks) = inner.store.restore_session(new_session_id);
		inner.expanded_blocks = blocks;

		let list_state = ListState::new(turn_count, ListAlignment::Bottom, px(200.0));
		if let Some(saved_offset) = saved_offset {
			list_state.set_follow_mode(FollowMode::Normal);
			list_state.scroll_to(saved_offset);
		} else {
			list_state.set_follow_mode(FollowMode::Tail);
			list_state.scroll_to_end();
		}

		inner.list_state = list_state;
		drop(inner);
		self.observe_scroll();
	}

	/// Synchronizes the viewport with the current turns slice and streaming
	/// status.
	pub fn sync_turns(&self, turns: &[Turn], is_streaming: bool) {
		let mut inner = self.0.borrow_mut();
		inner.is_streaming = is_streaming;

		let new_count = turns.len();
		let old_count = inner.turn_count;
		let mut content_changed = new_count != old_count;

		if new_count != old_count {
			if new_count > old_count {
				inner
					.list_state
					.splice(old_count..old_count, new_count - old_count);
			} else {
				inner.list_state.splice(new_count..old_count, 0);
			}
			inner.turn_count = new_count;
		}

		let mut fingerprints = Vec::with_capacity(turns.len());
		let mut modified_indices = Vec::new();

		for (ix, turn) in turns.iter().enumerate() {
			let fp = compute_turn_fingerprint(turn);
			fingerprints.push(fp);
			if let Some(&old_fp) = inner.last_turn_fingerprints.get(ix) {
				if old_fp != fp {
					modified_indices.push(ix);
					content_changed = true;
				}
			} else {
				content_changed = true;
			}
		}

		inner.last_turn_fingerprints = fingerprints;

		if content_changed {
			inner.turns = Rc::from(turns);
		}

		for ix in modified_indices {
			inner.list_state.remeasure_items(ix..ix + 1);
		}
	}

	/// Returns an O(1) reference-counted snapshot of the turns.
	#[must_use]
	pub fn turns_snapshot(&self) -> Rc<[Turn]> {
		self.0.borrow().turns.clone()
	}

	/// Toggles expand / collapse for a reasoning or tool invocation block.
	pub fn toggle_block_expanded(
		&self,
		turn_ix: usize,
		block_ix: usize,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) -> bool {
		let key = (turn_ix, block_ix);
		let mut inner = self.0.borrow_mut();

		let is_currently_expanded = inner.expanded_blocks.contains(&key);
		let next_expanded = !is_currently_expanded;

		if next_expanded {
			inner.expanded_blocks.insert(key);
		} else {
			inner.expanded_blocks.remove(&key);
		}

		let slot = ((turn_ix as u64) << 32) | (block_ix as u64);
		let reveal = inner
			.reveal_motions
			.entry(key)
			.or_insert_with(|| RevealMotion::new(SurfaceId::Transcript, slot, is_currently_expanded));
		reveal.set_expanded(next_expanded, tokens, reduced, now);

		inner.list_state.remeasure_items(turn_ix..turn_ix + 1);
		next_expanded
	}

	/// Sets explicit expand / collapse for a block.
	pub fn set_block_expanded(
		&self,
		turn_ix: usize,
		block_ix: usize,
		expanded: bool,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let key = (turn_ix, block_ix);
		let mut inner = self.0.borrow_mut();

		let is_currently_expanded = inner.expanded_blocks.contains(&key);
		if is_currently_expanded == expanded {
			return;
		}

		if expanded {
			inner.expanded_blocks.insert(key);
		} else {
			inner.expanded_blocks.remove(&key);
		}

		let slot = ((turn_ix as u64) << 32) | (block_ix as u64);
		let reveal = inner
			.reveal_motions
			.entry(key)
			.or_insert_with(|| RevealMotion::new(SurfaceId::Transcript, slot, is_currently_expanded));
		reveal.set_expanded(expanded, tokens, reduced, now);

		inner.list_state.remeasure_items(turn_ix..turn_ix + 1);
	}

	/// Returns whether a block is currently expanded.
	#[must_use]
	pub fn is_block_expanded(&self, turn_ix: usize, block_ix: usize) -> bool {
		self
			.0
			.borrow()
			.expanded_blocks
			.contains(&(turn_ix, block_ix))
	}

	/// Focuses a turn by index, executing `scroll_to_reveal_item` when index
	/// changes.
	pub fn focus_turn(&self, turn_ix: usize) {
		let mut inner = self.0.borrow_mut();
		if inner.last_focused_turn != Some(turn_ix) {
			inner.last_focused_turn = Some(turn_ix);
			inner.list_state.scroll_to_reveal_item(turn_ix);
		}
	}

	/// Clears the last focused turn index when focus is disengaged.
	pub fn clear_focused_turn(&self) {
		self.0.borrow_mut().last_focused_turn = None;
	}

	/// Scrolls the list so that `turn_ix` is fully visible.
	pub fn scroll_to_turn(&self, turn_ix: usize) {
		let inner = self.0.borrow();
		inner.list_state.scroll_to_reveal_item(turn_ix);
	}

	/// Returns whether the viewport is currently following the tail.
	#[must_use]
	pub fn is_following_tail(&self) -> bool {
		self.0.borrow().list_state.is_following_tail()
	}

	/// Pauses tail following, keeping the current scroll position stable.
	pub fn pause_following(&self) {
		self.0.borrow().list_state.pause_following_tail();
	}

	/// Sets the bottom clearance inset.
	pub fn set_bottom_inset(&self, inset_px: f32) {
		self.0.borrow_mut().bottom_inset_px = inset_px;
	}

	/// Returns the current bottom clearance inset.
	#[must_use]
	pub fn bottom_inset(&self) -> f32 {
		self.0.borrow().bottom_inset_px
	}

	/// Returns a clone of the underlying GPUI `ListState`.
	#[must_use]
	pub fn list_state(&self) -> ListState {
		self.0.borrow().list_state.clone()
	}

	/// Returns the active session ID, if any.
	#[must_use]
	pub fn session_id(&self) -> Option<u64> {
		self.0.borrow().session_id
	}

	/// Returns the number of turns currently in the list.
	#[must_use]
	pub fn turn_count(&self) -> usize {
		self.0.borrow().turn_count
	}

	/// Returns whether streaming is active.
	#[must_use]
	pub fn is_streaming(&self) -> bool {
		self.0.borrow().is_streaming
	}

	/// Returns the current logical scroll position.
	#[must_use]
	pub fn logical_scroll_top(&self) -> ListOffset {
		self.0.borrow().list_state.logical_scroll_top()
	}
}
