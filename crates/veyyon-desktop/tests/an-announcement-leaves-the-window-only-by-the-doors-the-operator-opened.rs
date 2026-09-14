//! WHY: `notify.sound` and `notify.system` are the two settings that decide
//! what an announcement does outside the window. A setting that appears in the
//! defaults and reaches no behavior is a dead flag, and the failure it hides
//! is the worse direction: a notifier that is not installed, a setting the
//! operator turned on, and nothing to hear.
//!
//! CLASS CLOSED: every door an announcement can leave by, proven shut when
//! the setting is off and open when it is on, for every source the queue has
//! -- swept from `NotificationSource` at run time, so a fourth source turns
//! this red until someone states whether it is carried. Also the two
//! properties that make delivery safe to run on every host batch: one card is
//! carried once however many frames it is up for, and a carrier that could
//! not run is announced once rather than announced for every card behind it.
//!
//! NOT CAUGHT: whether the platform's own notifier draws anything. The argv
//! this builds is spawned by the operator's desktop, and a test that asserted
//! on `notify-send`'s output would be asserting on their session.

use std::cell::RefCell;

use serde_json::json;
use strum::IntoEnumIterator;
use veyyon_desktop::{
	NoticeCarrier, NoticeDelivery, SOUND_SETTING, SYSTEM_SETTING, announcement_sound,
	system_notification,
};
use veyyon_desktop_model::{
	HostEvent, Notification, NotificationPriority, NotificationSource, SettingEntry, SettingKind,
	SettingsView, SnapshotSection, Store, reduce,
};

const NOW_MS: u64 = 1_700_000_000_000;

/// A carrier that records every call, refusing when it was built to.
#[derive(Debug, Default)]
struct Recorder {
	rings:      RefCell<usize>,
	posts:      RefCell<Vec<String>>,
	ring_fails: bool,
	post_fails: bool,
}

impl Recorder {
	fn refusing() -> Self {
		Self { ring_fails: true, post_fails: true, ..Self::default() }
	}

	fn rings(&self) -> usize {
		*self.rings.borrow()
	}

	fn posted(&self) -> Vec<String> {
		self.posts.borrow().clone()
	}
}

impl NoticeCarrier for Recorder {
	fn ring(&self) -> Result<(), String> {
		*self.rings.borrow_mut() += 1;
		if self.ring_fails {
			return Err("no player installed".to_owned());
		}
		Ok(())
	}

	fn post(&self, notification: &Notification) -> Result<(), String> {
		self.posts.borrow_mut().push(notification.key.clone());
		if self.post_fails {
			return Err("no notification service".to_owned());
		}
		Ok(())
	}
}

/// A store holding the two delivery settings at the given values, through the
/// reducer the host's snapshot goes through.
fn store_with(sound: Option<&str>, system: Option<&str>) -> Store {
	let mut store = Store::default();
	let mut settings = SettingsView::new();
	for (key, value) in [(SOUND_SETTING, sound), (SYSTEM_SETTING, system)] {
		if let Some(value) = value {
			settings.insert(key.to_owned(), SettingEntry {
				value:       json!(value),
				default:     json!("off"),
				source:      "profile".to_owned(),
				kind:        SettingKind::Enum,
				label:       Some("Announcement".to_owned()),
				description: None,
				tab:         Some("interaction".to_owned()),
				group:       Some("Notifications".to_owned()),
				values:      vec!["on".to_owned(), "off".to_owned()],
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			});
		}
	}
	let _damage = reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Settings(settings)));
	store
}

fn announcement(key: &str, source: NotificationSource) -> Notification {
	Notification {
		key: key.to_owned(),
		source,
		priority: NotificationPriority::Normal,
		title: "something happened out of view".to_owned(),
		detail: None,
		raised_at_ms: NOW_MS,
	}
}

#[test]
fn a_window_that_has_heard_no_settings_carries_an_announcement_nowhere() {
	let mut store = store_with(None, None);
	assert!(
		!announcement_sound(&store),
		"the schema defaults both doors shut, and so does a window that has heard nothing"
	);
	assert!(!system_notification(&store));

	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	let carrier = Recorder::default();
	assert!(!NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS));
	assert_eq!(carrier.rings(), 0);
	assert!(carrier.posted().is_empty());
}

#[test]
fn a_setting_the_operator_turned_off_is_the_same_as_one_never_reported() {
	let mut store = store_with(Some("off"), Some("off"));
	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	let carrier = Recorder::default();
	NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS);
	assert_eq!(carrier.rings(), 0, "off is off, stated or defaulted");
	assert!(carrier.posted().is_empty());
}

#[test]
fn a_value_the_window_does_not_know_leaves_the_door_shut() {
	let store = store_with(Some("yes"), Some("1"));
	assert!(
		!announcement_sound(&store),
		"`on` is the one value that opens it: a third value is not read as a third meaning"
	);
	assert!(!system_notification(&store));
}

#[test]
fn each_setting_opens_only_its_own_door() {
	let mut sound_only = store_with(Some("on"), Some("off"));
	sound_only
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	let carrier = Recorder::default();
	NoticeDelivery::new().carry(&mut sound_only, &carrier, NOW_MS);
	assert_eq!(carrier.rings(), 1, "the sound setting rang it");
	assert!(carrier.posted().is_empty(), "and posted nothing the operator did not ask for");

	let mut system_only = store_with(Some("off"), Some("on"));
	system_only
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	let carrier = Recorder::default();
	NoticeDelivery::new().carry(&mut system_only, &carrier, NOW_MS);
	assert_eq!(carrier.rings(), 0);
	assert_eq!(carrier.posted(), vec!["k".to_owned()]);
}

#[test]
fn every_source_the_queue_raises_is_carried_except_the_one_about_carrying() {
	for source in NotificationSource::iter() {
		let mut store = store_with(Some("on"), Some("on"));
		store
			.notifications
			.raise(announcement(source.as_str(), source));
		let carrier = Recorder::default();
		NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS);

		let carried = !carrier.posted().is_empty();
		let expected = source != NotificationSource::DeliveryFailed;
		assert_eq!(
			carried, expected,
			"{source:?} is carried: {expected}, and the window did: {carried}"
		);
		assert_eq!(
			carrier.rings(),
			usize::from(expected),
			"{source:?} rings exactly when it is carried"
		);
	}
}

#[test]
fn a_card_that_stays_up_is_carried_once_and_a_second_card_is_carried_too() {
	let mut store = store_with(Some("on"), Some("on"));
	let mut delivery = NoticeDelivery::new();
	store
		.notifications
		.raise(announcement("first", NotificationSource::RequestFailed));

	delivery.carry(&mut store, &Recorder::default(), NOW_MS);
	assert!(delivery.has_carried("first"));

	let carrier = Recorder::default();
	// The same card is still up two batches later, which is every batch the
	// host sends while the operator reads it.
	store
		.notifications
		.raise(announcement("first", NotificationSource::RequestFailed));
	delivery.carry(&mut store, &carrier, NOW_MS + 1);
	delivery.carry(&mut store, &carrier, NOW_MS + 2);
	assert_eq!(carrier.rings(), 0, "an announcement already stated is not stated again");
	assert!(carrier.posted().is_empty());

	store
		.notifications
		.raise(announcement("second", NotificationSource::RequestFailed));
	delivery.carry(&mut store, &carrier, NOW_MS + 3);
	assert_eq!(carrier.posted(), vec!["second".to_owned()], "and a new one is");
}

#[test]
fn a_card_dismissed_and_raised_again_is_a_new_announcement() {
	let mut store = store_with(Some("off"), Some("on"));
	let mut delivery = NoticeDelivery::new();
	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	delivery.carry(&mut store, &Recorder::default(), NOW_MS);

	store.notifications.dismiss("k");
	let carrier = Recorder::default();
	delivery.carry(&mut store, &carrier, NOW_MS + 1);
	assert!(!delivery.has_carried("k"), "what is no longer up is forgotten");

	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	delivery.carry(&mut store, &carrier, NOW_MS + 2);
	assert_eq!(
		carrier.posted(),
		vec!["k".to_owned()],
		"the same thing happening again is announced again"
	);
}

#[test]
fn a_burst_of_cards_is_one_sound_and_one_notification_each() {
	let mut store = store_with(Some("on"), Some("on"));
	for index in 0..6_u32 {
		store
			.notifications
			.raise(announcement(&format!("k{index}"), NotificationSource::RequestFailed));
	}
	let carrier = Recorder::default();
	NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS);
	assert_eq!(carrier.rings(), 1, "six alerts over one another state less than one");
	assert_eq!(carrier.posted().len(), 6, "and each card is its own notification");
}

#[test]
fn a_carrier_that_cannot_run_is_announced_once_and_never_carried_itself() {
	let mut store = store_with(Some("on"), Some("on"));
	let mut delivery = NoticeDelivery::new();
	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));

	let carrier = Recorder::refusing();
	assert!(
		delivery.carry(&mut store, &carrier, NOW_MS),
		"a delivery that did not happen is raised, which asks for the repaint that draws it"
	);
	let failures: Vec<&str> = store
		.notifications
		.raised()
		.iter()
		.filter(|notice| notice.source == NotificationSource::DeliveryFailed)
		.map(|notice| notice.key.as_str())
		.collect();
	assert_eq!(failures, vec!["delivery-failed:sound", "delivery-failed:system"]);
	assert!(
		store
			.notifications
			.raised()
			.iter()
			.filter(|notice| notice.source == NotificationSource::DeliveryFailed)
			.all(|notice| notice.priority == NotificationPriority::Low),
		"the window's own trouble does not outrank the session's"
	);

	// The recursion this guards: the failure cards are on the stack now, and
	// a second pass must not try to carry them and raise two more.
	let posted_before = carrier.posted().len();
	let rings_before = carrier.rings();
	assert!(!delivery.carry(&mut store, &carrier, NOW_MS + 1));
	assert_eq!(carrier.posted().len(), posted_before, "a failure card is carried nowhere");
	assert_eq!(carrier.rings(), rings_before);
	assert_eq!(
		store
			.notifications
			.raised()
			.iter()
			.filter(|notice| notice.source == NotificationSource::DeliveryFailed)
			.count(),
		2,
		"and it is announced once per carrier, not once per card behind it"
	);
}

#[test]
fn only_the_carrier_that_refused_is_announced() {
	let mut store = store_with(Some("on"), Some("on"));
	let carrier = Recorder { post_fails: true, ..Recorder::default() };
	NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS);
	assert!(
		store.notifications.is_empty(),
		"with no announcement raised there is nothing to carry and nothing to report"
	);

	store
		.notifications
		.raise(announcement("k", NotificationSource::RequestFailed));
	NoticeDelivery::new().carry(&mut store, &carrier, NOW_MS);
	assert!(store.notifications.holds("delivery-failed:system"));
	assert!(
		!store.notifications.holds("delivery-failed:sound"),
		"the sound played, so nothing is said about it"
	);
}
