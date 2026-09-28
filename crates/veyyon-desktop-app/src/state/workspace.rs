//! The workspace's reads and writes of the window state: the announcement
//! stack it draws as toasts, the layout it persists per session, and the
//! session a new window reopens. Every region pushes through
//! [`AppState::announce`]; the stack takes an announcement down when it is
//! dismissed or its time is up.

use veyyon_desktop_model::{Notification, PanelsStore, Raised};
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

	/// Records the regions' sizes, visibility and right panel tab from the
	/// workspace's `layout` as the displayed session's persisted layout,
	/// keeping the fields the panel and the drawer write, and schedules the
	/// window's write of it. Does nothing while no session is displayed.
	pub fn record_layout(&mut self, layout: &PanelsStore, cx: &mut Context<Self>) {
		let Some(session) = self.displayed.clone() else {
			return;
		};
		self.remember(cx, |persisted| {
			let panels = persisted.panels.entry(session).or_default();
			panels.right_panel_visible = layout.right_panel_visible;
			panels.right_panel_width = layout.right_panel_width;
			panels.queue_width = layout.queue_width;
			panels.drawer_visible = layout.drawer_visible;
			panels.drawer_height = layout.drawer_height;
			panels.active_right_tab.clone_from(&layout.active_right_tab);
		});
	}

	/// Asks the host for the session the last window displayed, which the
	/// window shows from the persisted state before the host answers. Call it
	/// once, after the host's session list arrived: a session the host still
	/// lists is opened, and one it no longer lists is dropped, so the window
	/// shows no session rather than the header of one that is gone.
	pub fn reopen_remembered(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.displayed.clone() else {
			return;
		};
		if self.store.sessions.items.contains_key(&session) {
			self.open_session(session, cx);
			return;
		}
		self.displayed = None;
		if self.store.persisted.shell.active_session.as_ref() == Some(&session) {
			self.store.persisted.shell.active_session = None;
		}
		cx.emit(StoreEvent::ActiveSessionChanged);
	}
}
