//! Reducers and command dispatch for notification state.
//!
//! Exposes store operations for creating, deduplicating, dismissing, and
//! expiring notifications, as well as updating notification sound and error
//! persistence preferences.

use crate::{
	command::UiCommand,
	model::{Notification, NotificationId, NotificationKey, NotificationTone},
	store::{Effects, ShellEffect, Store},
};

impl Store {
	/// Insert a notification into the replica queue.
	///
	/// If notification sound is enabled in preferences, an audio playback
	/// effect or notification event is scheduled at this decision point.
	pub fn push_notification(
		&mut self,
		notification: Notification,
		effects: &mut Effects,
	) -> NotificationId {
		if self.replica.notifications.settings.sound {
			// Decision point for audio chime. Zero audio dependencies exist in
			// core/kit, so we route through ShellEffect::Notify.
			effects
				.shell
				.push(ShellEffect::Notify { message: notification.title.clone() });
		}
		self.replica.notifications.push(notification)
	}

	/// Create and push a new notification with automatic key and id derivation.
	pub fn notify(&mut self, notification: Notification, effects: &mut Effects) -> NotificationId {
		self.push_notification(notification, effects)
	}

	/// Push an error notification. Errors never auto-expire.
	pub fn notify_error(
		&mut self,
		title: impl Into<String>,
		detail: Option<String>,
		now_ms: u64,
		effects: &mut Effects,
	) -> NotificationId {
		let id = self.replica.notifications.next_id();
		let title_string = title.into();
		let key = NotificationKey::new(title_string.clone());
		let mut notification =
			Notification::new(id, key, NotificationTone::Error, title_string, now_ms);
		notification.detail = detail;
		self.push_notification(notification, effects)
	}

	/// Dismiss a single notification by id.
	pub fn dismiss_notification(&mut self, id: &NotificationId) -> bool {
		self.replica.notifications.dismiss(id)
	}

	/// Dismiss all notifications from the queue.
	pub fn dismiss_all_notifications(&mut self) {
		self.replica.notifications.dismiss_all();
	}

	/// Mark a notification as read.
	pub fn mark_notification_read(&mut self, id: &NotificationId) -> bool {
		self.replica.notifications.mark_read(id)
	}

	/// Advance notification queue expiration using the current frame instant.
	pub fn sweep_notifications(&mut self, now_ms: u64) {
		self.replica.notifications.sweep(now_ms);
	}

	/// Pause or resume notification expiration on pointer hover.
	pub fn set_notification_hover_held(&mut self, held: bool) {
		self.replica.notifications.set_hover_held(held);
	}

	/// Update notification sound playback preference.
	pub fn set_notification_sound(&mut self, sound: bool) {
		self.replica.notifications.settings.sound = sound;
	}

	/// Update whether errors remain on screen after being read.
	pub fn set_notification_persist_errors(&mut self, persist: bool) {
		self.replica.notifications.settings.persist_errors = persist;
	}

	/// Dispatch notification-specific commands if matched.
	pub(super) fn dispatch_notify(&mut self, command: &UiCommand, _effects: &mut Effects) -> bool {
		match command {
			UiCommand::EditSetting { path, value } if path.0 == "notifications.sound" => {
				if let crate::model::Value::Bool(b) = value {
					self.set_notification_sound(*b);
					return true;
				}
				false
			},
			UiCommand::EditSetting { path, value }
				if path.0 == "notifications.persist_errors"
					|| path.0 == "notifications.persist-errors" =>
			{
				if let crate::model::Value::Bool(b) = value {
					self.set_notification_persist_errors(*b);
					return true;
				}
				false
			},
			_ => false,
		}
	}
}
