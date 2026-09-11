//! What an announcement does besides going on the window's own stack (§5.15).
//!
//! The stack is silent and inside the window, which is right for an operator
//! who is looking at it and wrong for one who is not. Two settings state what
//! else a raised announcement does: `notify.sound` plays the desktop alert,
//! `notify.system` hands the announcement to the desktop's own notification
//! service. Both default off.
//!
//! A carrier that cannot run is announced rather than dropped, on the same
//! stack, once per carrier while it is up. That announcement is the one kind
//! that is never carried anywhere itself, so a missing notifier cannot
//! announce its own absence for every card that follows.

pub mod platform;

use std::collections::HashSet;

pub use platform::DesktopCarrier;
use veyyon_desktop_model::{Notification, NotificationPriority, NotificationSource, Raised, Store};

/// The setting that states whether an announcement plays a sound.
pub const SOUND_SETTING: &str = "notify.sound";
/// The setting that states whether an announcement reaches the desktop's own
/// notification service.
pub const SYSTEM_SETTING: &str = "notify.system";

/// Whether a setting the host reports holds `on`.
///
/// The schema declares `on` and `off` and defaults to `off`, so `on` is the
/// one value that carries an announcement anywhere: a host reporting anything
/// else leaves delivery off rather than reading a third meaning into a value
/// the window does not know.
fn turned_on(store: &Store, setting: &str) -> bool {
	store
		.domains
		.settings
		.as_ref()
		.and_then(|settings| settings.get(setting))
		.and_then(|entry| entry.value.as_str())
		== Some("on")
}

/// Whether the operator asked for the desktop alert sound.
#[must_use]
pub fn announcement_sound(store: &Store) -> bool {
	turned_on(store, SOUND_SETTING)
}

/// Whether the operator asked for a desktop notification.
#[must_use]
pub fn system_notification(store: &Store) -> bool {
	turned_on(store, SYSTEM_SETTING)
}

/// One way an announcement leaves the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Carrier {
	/// The desktop alert sound.
	Sound,
	/// The desktop's own notification service.
	System,
}

impl Carrier {
	/// The key the announcement about this carrier's own failure is raised
	/// under, so one broken notifier is one card.
	#[must_use]
	pub const fn failure_key(self) -> &'static str {
		match self {
			Self::Sound => "delivery-failed:sound",
			Self::System => "delivery-failed:system",
		}
	}

	/// What the failure card states on its one line.
	#[must_use]
	pub const fn failure_title(self) -> &'static str {
		match self {
			Self::Sound => "The announcement sound did not play",
			Self::System => "The desktop notification was not posted",
		}
	}
}

/// What carries an announcement out of the window.
///
/// The window holds this as a trait so a test can drive the whole path --
/// settings, dedupe, failure reporting -- against a carrier that records
/// instead of one that reaches the operator's session.
pub trait NoticeCarrier {
	/// Plays the desktop alert once, stating why it could not.
	fn ring(&self) -> Result<(), String>;
	/// Hands one announcement to the desktop notification service, stating
	/// why it could not.
	fn post(&self, notification: &Notification) -> Result<(), String>;
}

/// Which announcements have already been carried, so a card that stays up for
/// a minute rings once rather than every second.
#[derive(Debug, Default)]
pub struct NoticeDelivery {
	carried: HashSet<String>,
}

impl NoticeDelivery {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Whether this announcement has already been carried.
	#[must_use]
	pub fn has_carried(&self, key: &str) -> bool {
		self.carried.contains(key)
	}

	/// Carries every announcement raised since the last call, and announces a
	/// carrier that could not run.
	///
	/// Returns whether anything was raised, which is the caller's signal to
	/// project and repaint.
	pub fn carry(&mut self, store: &mut Store, carrier: &dyn NoticeCarrier, now_ms: u64) -> bool {
		let held: HashSet<String> = store
			.notifications
			.raised()
			.iter()
			.map(|notice| notice.key.clone())
			.collect();
		// An announcement that came down and was raised again is a new
		// announcement: what is no longer held is forgotten first.
		self.carried.retain(|key| held.contains(key));

		let fresh: Vec<Notification> = store
			.notifications
			.raised()
			.iter()
			.filter(|notice| notice.source != NotificationSource::DeliveryFailed)
			.filter(|notice| !self.carried.contains(&notice.key))
			.cloned()
			.collect();
		if fresh.is_empty() {
			return false;
		}
		for notice in &fresh {
			self.carried.insert(notice.key.clone());
		}

		let mut failures: Vec<(Carrier, String)> = Vec::new();
		// However many cards arrived at once, the operator hears one alert:
		// six sounds over one another state less than one.
		if announcement_sound(store)
			&& let Err(reason) = carrier.ring()
		{
			failures.push((Carrier::Sound, reason));
		}
		if system_notification(store) {
			for notice in &fresh {
				if let Err(reason) = carrier.post(notice) {
					failures.push((Carrier::System, reason));
					break;
				}
			}
		}

		let mut raised = false;
		for (kind, reason) in failures {
			let changed = matches!(
				store.notifications.raise(Notification {
					key:          kind.failure_key().to_owned(),
					source:       NotificationSource::DeliveryFailed,
					priority:     NotificationPriority::Low,
					title:        kind.failure_title().to_owned(),
					detail:       Some(reason),
					raised_at_ms: now_ms,
				}),
				Raised::Added | Raised::Evicted(_)
			);
			raised |= changed;
		}
		raised
	}
}
