//! The stack of announcements the window draws over its own surfaces (§5.15).
//!
//! What is announced, how long it stays and how many are held at once is the
//! model's: the queue dedupes by key, orders by priority, expires by age and
//! is bounded. This module draws what that queue holds, and nothing else. A
//! card here holds no state of its own beyond the transition it is running, so
//! two frames of the same queue draw the same stack.
//!
//! The stack sits at the window's trailing edge under the chrome, where the
//! rail is not and the transcript column does not reach. It takes no layout
//! space: an announcement arriving never moves a word being read, which is the
//! difference between this and the attention strip, whose one line pushes the
//! columns down because it is part of the window's chrome.
//!
//! Each card animates on its own track, named for the surface that owns the
//! stack and slotted by the position the card holds. Two cards never share a
//! slot while both are drawn, so one arriving does not restart the transition
//! of the one under it.

use std::time::Instant;

use veyyon_desktop_kit::{SpacingStep, TOAST_WIDTH_PX, TintRole, Toast};
use veyyon_desktop_model::{Notification, NotificationPriority, NotificationSource};
use veyyon_desktop_motion::{FloatFrame, FloatMotion, SurfaceId};
use veyyon_gpui::{
	Anchor, AnyElement, Context, IntoElement, ParentElement, Point, Styled, Window, anchored,
	deferred, div, px,
};

use super::ShellView;
use crate::intent::Intent;

/// What an announcement with no detail of its own states under its line while
/// it waits on an answer.
const WAITING_DETAIL: &str = "Waiting for an answer";

/// The tint a card is drawn on, which states what kind of announcement it is
/// without reading its words.
const fn notice_tint(source: NotificationSource) -> TintRole {
	match source {
		NotificationSource::DecisionWaiting => TintRole::Attention,
		NotificationSource::RequestFailed => TintRole::Error,
		// A notifier that did not run states what the window could not do,
		// not what the session could not do, so it is the quieter tint.
		NotificationSource::DeliveryFailed => TintRole::Plan,
	}
}

impl ShellView {
	/// Samples one entrance frame per drawn card, creating the track for a
	/// slot the stack has not reached before.
	///
	/// A slot's driver is kept for the life of the window. The stack is
	/// bounded, so the number of drivers is bounded by the same constant, and
	/// a card leaving its slot hands that track to whichever card takes it.
	fn sample_notice_motion(&mut self, count: usize) -> Vec<FloatFrame> {
		let now = Instant::now();
		let reduced = self.rail_motion.is_reduced_motion();
		let mut frames = Vec::with_capacity(count);
		for slot in 0..count {
			while self.notice_motion.len() <= slot {
				// A float driver keys two animators, the rise and the fade, at
				// `slot_base` and `slot_base + 1`, so a slot's base steps by two
				// and no two cards name one track.
				let next = u64::try_from(self.notice_motion.len() * 2).unwrap_or(u64::MAX);
				self
					.notice_motion
					.push(FloatMotion::new(SurfaceId::Notices, next));
			}
			frames.push(self.notice_motion[slot].sample(true, now, &self.installed.motion, reduced));
		}
		frames
	}
}

/// Draws the announcement stack, or nothing when the queue holds none.
///
/// `top_px` is where the window's chrome ends: the stack begins under it, so
/// the titlebar and an attention strip below it are never covered.
pub(super) fn toast_stack(
	view: &mut ShellView,
	top_px: f32,
	window: &Window,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	let count = view.state.notices.len();
	if count == 0 {
		return None;
	}
	let frames = view.sample_notice_motion(count);
	// A card mid-entrance asks for the next frame, the way every other float
	// in this window does: the transition is driven by the clock, not by the
	// events that raised the announcement.
	if frames.iter().any(|frame| !frame.settled) {
		let entity = cx.entity();
		window.on_next_frame(move |_window, app| entity.update(app, |_view, cx| cx.notify()));
	}

	let tokens = &view.installed.set;
	let gap = tokens.spacing(SpacingStep::S2);
	let margin = tokens.spacing(SpacingStep::S4);
	let mut column = div()
		.flex()
		.flex_col()
		.items_end()
		.gap(gap)
		.w(px(TOAST_WIDTH_PX));
	for (notice, frame) in view.state.notices.iter().zip(frames) {
		column = column.child(card(notice, frame, cx));
	}

	let position = Point { x: window.viewport_size().width - margin, y: px(top_px) + margin };
	let floating = anchored()
		.position(position)
		.anchor(Anchor::TopRight)
		.snap_to_window_with_margin(margin);
	Some(
		deferred(floating.child(column))
			.with_priority(2)
			.into_any_element(),
	)
}

/// One announcement's card, dismissed by a press on it.
fn card(notice: &Notification, frame: FloatFrame, cx: &Context<ShellView>) -> impl IntoElement {
	let entity = cx.weak_entity();
	let dismissed = notice.key.clone();
	let mut toast = Toast::new(format!("notice-{}", notice.key), notice.title.clone())
		.tint(notice_tint(notice.source))
		.entrance(frame)
		.on_dismiss(move |_window, app| {
			let Some(entity) = entity.upgrade() else {
				return;
			};
			let key = dismissed.clone();
			entity.update(app, |view, cx| {
				view.dispatch(Intent::DismissNotice(key), cx);
			});
		});
	// An announcement that does not expire on its own states that it is
	// waiting on an answer rather than on a clock, so a card that stays is
	// not read as a card that failed to go.
	let detail = notice.detail.clone().or_else(|| {
		(notice.priority == NotificationPriority::Urgent).then(|| WAITING_DETAIL.to_string())
	});
	if let Some(detail) = detail {
		toast = toast.detail(detail);
	}
	toast
}
