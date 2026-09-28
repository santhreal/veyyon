//! The announcement stack the workspace draws as toasts. Every region pushes
//! through [`AppState::announce`]; the stack takes an announcement down when
//! it is dismissed or its time is up.

use veyyon_desktop_model::{Notification, Raised};
use veyyon_gpui::Context;

use super::{AppState, StoreEvent};

impl AppState {
	/// Raises `notification` on the stack, merging it into the announcement
	/// that holds its key, and emits [`StoreEvent::NotificationsChanged`]
	/// unless the full stack refused it.
	pub fn announce(&mut self, notification: Notification, cx: &mut Context<Self>) -> Raised {
		let raised = self.store.notifications.raise(notification);
		if raised != Raised::Refused {
			cx.emit(StoreEvent::NotificationsChanged);
		}
		raised
	}

	/// Takes the announcement under `key` off the stack.
	pub fn dismiss_notification(&mut self, key: &str, cx: &mut Context<Self>) {
		if self.store.notifications.dismiss(key) {
			cx.emit(StoreEvent::NotificationsChanged);
		}
	}

	/// Takes every announcement whose time is up at `now_ms`, on the clock
	/// the host stamps announcements with, off the stack.
	pub fn expire_notifications(&mut self, now_ms: u64, cx: &mut Context<Self>) {
		if self.store.notifications.expire(now_ms) > 0 {
			cx.emit(StoreEvent::NotificationsChanged);
		}
	}
}
