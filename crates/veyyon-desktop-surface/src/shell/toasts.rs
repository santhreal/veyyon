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
//! Each card animates on its own float motion, one per position in the stack,
//! so a card arriving does not restart the transition of the one under it.

use veyyon_desktop_kit::{SpacingStep, TOAST_WIDTH_PX, TintRole, Toast};
use veyyon_desktop_model::{Notification, NotificationPriority, NotificationSource};
use veyyon_desktop_motion::{FloatFrame, FloatMotion};
use veyyon_gpui::{
	Anchor, AnyElement, Context, IntoElement, ParentElement, Point, Styled, Window, anchored,
	deferred, div, motion::MotionFrame, px,
};

use super::ShellView;
use crate::intent::Intent;

/// What an announcement with no detail of its own states under its line while
/// it waits on an answer.
const WAITING_DETAIL: &str = "Waiting for an answer";

/// The tint a card is drawn on, which states what kind of announcement it is
/// without reading its words.
const fn notice_tint(notice: &Notification) -> TintRole {
	match notice.source {
		NotificationSource::DecisionWaiting => TintRole::Attention,
		NotificationSource::RequestFailed => TintRole::Error,
		// A notifier that did not run states what the window could not do,
		// not what the session could not do, so it is the quieter tint.
		NotificationSource::DeliveryFailed => TintRole::Plan,
		// An extension's notice carries the level it stated as its priority:
		// an error, a warning, or a notice that is the quieter tint.
		NotificationSource::Extension => match notice.priority {
			NotificationPriority::Urgent => TintRole::Error,
			NotificationPriority::Normal => TintRole::Attention,
			NotificationPriority::Low => TintRole::Plan,
		},
	}
}

impl ShellView {
	/// Samples one entrance frame per drawn card on `frame`, creating the
	/// float motion for a position the stack has not reached before.
	///
	/// A position's motion is kept for the life of the window. The stack is
	/// bounded, so the number of motions is bounded by the same constant, and
	/// a card leaving its position hands that motion to whichever card takes
	/// it.
	fn sample_notice_motion(&mut self, count: usize, frame: &mut MotionFrame) -> Vec<FloatFrame> {
		if self.notice_motion.len() < count {
			self.notice_motion.resize_with(count, FloatMotion::new);
		}
		let (policy, now) = (frame.policy(), frame.now());
		self.notice_motion[..count]
			.iter_mut()
			.map(|motion| {
				motion.set_open(true, &self.installed.motion, policy, now);
				frame.track(motion);
				motion.current()
			})
			.collect()
	}
}

/// Draws the announcement stack, or nothing when the queue holds none.
///
/// `top_px` is where the window's chrome ends: the stack begins under it, so
/// the titlebar and an attention strip below it are never covered.
pub(super) fn toast_stack(
	view: &mut ShellView,
	top_px: f32,
	frame: &mut MotionFrame,
	window: &Window,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	let count = view.state.notices.len();
	if count == 0 {
		return None;
	}
	let frames = view.sample_notice_motion(count, frame);

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
		.tint(notice_tint(notice))
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
