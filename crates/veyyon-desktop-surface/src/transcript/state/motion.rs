//! Measured viewport scrolling and retained reveal geometry.

use std::time::Instant;

use veyyon_desktop_motion::MotionTokens;
use veyyon_gpui::{App, FocusHandle, FollowMode, ListOffset, Pixels, px};

use super::{TranscriptViewportState, TranscriptViewportStateInner};

fn apply_scroll_position(inner: &TranscriptViewportStateInner, position: f32) {
	let current = -f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y);
	inner.list_state.scroll_by(px(position - current));
	if position <= 0.001 {
		inner
			.list_state
			.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
	}
}

fn start_scroll(
	inner: &mut TranscriptViewportStateInner,
	target: f32,
	tokens: &MotionTokens,
	reduced: bool,
	now: Instant,
) {
	let current = -f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y);
	inner.list_state.set_follow_mode(FollowMode::Normal);
	inner.scroll_motion.set_direct(current, now);
	inner
		.scroll_motion
		.scroll_to(target.max(0.0), tokens, reduced, now);
	inner.scroll_expected_px = Some(current);
	let (position, settled) = inner.scroll_motion.sample(now);
	if settled {
		apply_scroll_position(inner, position);
		inner.scroll_expected_px = None;
		if inner.scroll_follow_end {
			inner.list_state.set_follow_mode(FollowMode::Tail);
			inner.list_state.scroll_to_end();
			inner.scroll_follow_end = false;
		}
	}
}

impl TranscriptViewportState {
	pub(super) fn observe_scroll(&self) {
		let weak = std::rc::Rc::downgrade(&self.0);
		self.list_state().set_scroll_handler(move |_, _, _| {
			if let Some(state) = weak.upgrade() {
				let mut inner = state.borrow_mut();
				inner.scroll_expected_px = None;
				inner.scroll_follow_end = false;
			}
		});
	}

	/// Cancels animated scrolling and applies manual movement.
	pub fn scroll_by(&self, distance: Pixels) {
		let mut inner = self.0.borrow_mut();
		inner.scroll_expected_px = None;
		inner.scroll_follow_end = false;
		inner.list_state.set_follow_mode(FollowMode::Normal);
		inner.list_state.scroll_by(distance);
	}

	/// Selects a logical position without following newly appended content.
	pub fn scroll_to(&self, offset: ListOffset) {
		let mut inner = self.0.borrow_mut();
		inner.scroll_expected_px = None;
		inner.scroll_follow_end = false;
		inner.list_state.set_follow_mode(FollowMode::Normal);
		inner.list_state.scroll_to(offset);
	}

	/// Selects the live edge and follows newly appended content.
	pub fn scroll_to_end(&self) {
		let mut inner = self.0.borrow_mut();
		inner.scroll_expected_px = None;
		inner.scroll_follow_end = false;
		inner.list_state.set_follow_mode(FollowMode::Tail);
		inner.list_state.scroll_to_end();
	}

	/// Retains keyboard focus across transcript renders and session changes.
	pub fn focus_handle(&self, cx: &App) -> FocusHandle {
		self
			.0
			.borrow_mut()
			.focus
			.get_or_insert_with(|| cx.focus_handle())
			.clone()
	}

	/// Animates a viewport-relative page without changing its logical anchor
	/// abruptly.
	pub fn scroll_by_animated(
		&self,
		distance: Pixels,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let mut inner = self.0.borrow_mut();
		let current = -f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y);
		inner.scroll_follow_end = false;
		start_scroll(&mut inner, current + f32::from(distance), tokens, reduced, now);
	}

	/// Animates a logical jump using the list's measured row heights.
	pub fn scroll_to_animated(
		&self,
		offset: ListOffset,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let mut inner = self.0.borrow_mut();
		if offset.item_ix == 0 && offset.offset_in_item == px(0.0) {
			inner.scroll_follow_end = false;
			start_scroll(&mut inner, 0.0, tokens, reduced, now);
		} else {
			let original = inner.list_state.logical_scroll_top();
			inner.list_state.scroll_to(offset);
			let target = -f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y);
			inner.list_state.scroll_to(original);
			inner.scroll_follow_end = false;
			start_scroll(&mut inner, target, tokens, reduced, now);
		}
	}

	/// Reveals a measured turn through the configured scroll transition.
	pub fn scroll_to_turn_animated(
		&self,
		turn: usize,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let mut inner = self.0.borrow_mut();
		let original = inner.list_state.logical_scroll_top();
		inner.list_state.scroll_to_reveal_item(turn);
		let target = -f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y);
		inner.list_state.scroll_to(original);
		inner.scroll_follow_end = false;
		start_scroll(&mut inner, target, tokens, reduced, now);
	}

	/// Animates to the tail and resumes following after the transition settles.
	pub fn scroll_to_end_animated(&self, tokens: &MotionTokens, reduced: bool, now: Instant) {
		let mut inner = self.0.borrow_mut();
		let target = f32::from(inner.list_state.max_offset_for_scrollbar().y);
		inner.scroll_follow_end = true;
		start_scroll(&mut inner, target, tokens, reduced, now);
	}

	/// Samples the caret without allocating per-frame state.
	pub fn sample_caret(&self, now: Instant, tokens: &MotionTokens, reduced: bool) -> (f32, bool) {
		let mut inner = self.0.borrow_mut();
		let streaming = inner.is_streaming;
		inner.caret_motion.sample(streaming, now, tokens, reduced)
	}

	/// Applies sampled scroll motion; manual scroll cancels the programmatic
	/// jump.
	pub fn sample_scroll(&self, now: Instant) -> (f32, bool) {
		let mut inner = self.0.borrow_mut();
		if let Some(expected) = inner.scroll_expected_px {
			let (position, settled) = inner.scroll_motion.sample(now);
			inner.list_state.scroll_by(px(position - expected));
			if settled && position <= 0.001 {
				inner
					.list_state
					.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
			}
			inner.scroll_expected_px = (!settled).then_some(position);
			if settled && inner.scroll_follow_end {
				inner.list_state.set_follow_mode(FollowMode::Tail);
				inner.list_state.scroll_to_end();
				inner.scroll_follow_end = false;
			}
			(position, settled)
		} else {
			(-f32::from(inner.list_state.scroll_px_offset_for_scrollbar().y), true)
		}
	}

	/// Returns reveal progress for an individual content block.
	pub fn sample_reveal(&self, turn: usize, block: usize, now: Instant) -> (f32, bool) {
		let mut inner = self.0.borrow_mut();
		let key = (turn, block);
		if let Some(motion) = inner.reveal_motions.get_mut(&key) {
			motion.sample(now)
		} else {
			(
				if inner.expanded_blocks.contains(&key) {
					1.0
				} else {
					0.0
				},
				true,
			)
		}
	}

	/// Returns the clip fraction and measured natural height of reveal content.
	pub fn reveal_frame(&self, turn: usize, block: usize, now: Instant) -> (f32, f32) {
		let progress = self.sample_reveal(turn, block, now).0.clamp(0.0, 1.0);
		let height = self
			.0
			.borrow()
			.reveal_heights
			.get(&(turn, block))
			.copied()
			.unwrap_or(0.0);
		(progress, height)
	}

	/// Computes the clip height without spatial motion for fade-only reveals.
	pub fn reveal_clip_height(
		&self,
		turn: usize,
		block: usize,
		progress: f32,
		natural_height: f32,
	) -> f32 {
		let inner = self.0.borrow();
		if inner
			.reveal_motions
			.get(&(turn, block))
			.is_some_and(|motion| !motion.animates_height())
		{
			natural_height
		} else {
			natural_height * progress
		}
	}

	/// Records natural height; remeasurement waits until list prepaint releases
	/// its borrow.
	pub fn record_reveal_height(&self, turn: usize, block: usize, height: f32) -> bool {
		let mut inner = self.0.borrow_mut();
		if inner.reveal_heights.get(&(turn, block)) == Some(&height) {
			return false;
		}
		inner.reveal_heights.insert((turn, block), height);
		inner.pending_remeasure.insert(turn);
		true
	}

	/// Advances every active driver and remeasures animated list rows.
	#[must_use]
	pub fn is_animating(&self, now: Instant, tokens: &MotionTokens, reduced: bool) -> bool {
		let mut active = !self.sample_scroll(now).1;
		let mut inner = self.0.borrow_mut();
		let streaming = inner.is_streaming;
		active |= !inner.caret_motion.sample(streaming, now, tokens, reduced).1;
		let list = inner.list_state.clone();
		for turn in inner.pending_remeasure.drain() {
			list.remeasure_items(turn..turn + 1);
		}
		for ((turn, _), motion) in &mut inner.reveal_motions {
			let was_active = !motion.is_settled();
			let settled = motion.sample(now).1;
			if was_active || !settled {
				list.remeasure_items(*turn..*turn + 1);
			}
			active |= !settled;
		}
		active
	}
}
