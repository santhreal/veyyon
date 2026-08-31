//! WHY. Background failures and events were previously silent or dropped into
//! unobserved Option<String> fields. Notifications must queue reliably with
//! strict bounds, deduplicate repeated occurrences, and expire
//! deterministically on frame time without dropping persistent error
//! conditions.
//!
//! WHAT THIS DOES NOT CATCH. This suite exercises core data model queues and
//! store reducers; visual rendering and window-level hit testing live in kit
//! and features suites.

use crate::model::*;

#[test]
fn dedupe_by_key_increments_count_and_updates_contents() {
	let mut queue = NotificationQueue::new();
	let id1 = NotificationId::new("note-1");
	let key = NotificationKey::new("file-read:test.rs");

	let note1 =
		Notification::new(id1.clone(), key.clone(), NotificationTone::Warn, "Read failed", 1000)
			.detail("Permission denied");
	let pushed_id1 = queue.push(note1);
	assert_eq!(pushed_id1, id1);
	assert_eq!(queue.len(), 1);
	assert_eq!(queue.entries()[0].count, 1);
	assert_eq!(queue.entries()[0].title, "Read failed");

	let id2 = NotificationId::new("note-2");
	let note2 = Notification::new(id2, key, NotificationTone::Error, "Read failed again", 2000)
		.detail("File not found");
	let pushed_id2 = queue.push(note2);

	// Deduplication preserves the original ID and raises count
	assert_eq!(pushed_id2, id1);
	assert_eq!(queue.len(), 1);
	let entry = &queue.entries()[0];
	assert_eq!(entry.count, 2);
	assert_eq!(entry.title, "Read failed again");
	assert_eq!(entry.detail.as_deref(), Some("File not found"));
	assert_eq!(entry.tone, NotificationTone::Error);
	assert_eq!(entry.created_at_ms, 2000);
}

#[test]
fn queue_bound_holds_under_a_thousand_pushes_evicting_oldest_lowest_priority() {
	let mut queue = NotificationQueue::new();

	// Insert an error early on
	let err_id = NotificationId::new("critical-err");
	let err_note = Notification::new(
		err_id.clone(),
		NotificationKey::new("err-key"),
		NotificationTone::Error,
		"Fatal error",
		100,
	);
	queue.push(err_note);

	// Push a thousand unique info notifications
	for i in 0..1000 {
		let note = Notification::new(
			NotificationId::new(format!("note-{i}")),
			NotificationKey::new(format!("key-{i}")),
			NotificationTone::Info,
			format!("Info message {i}"),
			1000 + i as u64,
		);
		queue.push(note);
		assert!(queue.len() <= MAX_QUEUE_CAPACITY);
	}

	assert_eq!(queue.len(), MAX_QUEUE_CAPACITY);

	// The high-priority error must not have been evicted by lower priority infos
	let has_err = queue.entries().iter().any(|e| e.id == err_id);
	assert!(has_err, "High-priority error was incorrectly evicted");
}

#[test]
fn errors_never_auto_expire_during_sweep() {
	let mut queue = NotificationQueue::new();

	let info_note = Notification::new(
		NotificationId::new("info-1"),
		NotificationKey::new("info-key"),
		NotificationTone::Info,
		"Info",
		1000,
	);
	let err_note = Notification::new(
		NotificationId::new("err-1"),
		NotificationKey::new("err-key"),
		NotificationTone::Error,
		"Error",
		1000,
	);

	queue.push(info_note);
	queue.push(err_note);
	assert_eq!(queue.len(), 2);

	// Advance time past default expiry (1000 + 5000 = 6000)
	queue.sweep(7000);

	assert_eq!(queue.len(), 1);
	assert_eq!(queue.entries()[0].tone, NotificationTone::Error);
	assert_eq!(queue.entries()[0].id.as_str(), "err-1");

	// Even advancing time far into the future, the error persists
	queue.sweep(1_000_000);
	assert_eq!(queue.len(), 1);
}

#[test]
fn expiry_is_monotonic_and_driven_by_frame_instant() {
	let mut queue = NotificationQueue::new();

	let note1 = Notification::new(
		NotificationId::new("note-1"),
		NotificationKey::new("k1"),
		NotificationTone::Ok,
		"Done 1",
		1000,
	);
	let note2 = Notification::new(
		NotificationId::new("note-2"),
		NotificationKey::new("k2"),
		NotificationTone::Warn,
		"Done 2",
		3000,
	);

	queue.push(note1);
	queue.push(note2);

	// At t = 5000, neither is expired (expiry is 6000 and 8000)
	queue.sweep(5000);
	assert_eq!(queue.len(), 2);

	// At t = 6500, note-1 is expired, note-2 remains
	queue.sweep(6500);
	assert_eq!(queue.len(), 1);
	assert_eq!(queue.entries()[0].id.as_str(), "note-2");

	// At t = 8500, note-2 expires
	queue.sweep(8500);
	assert_eq!(queue.len(), 0);
}

#[test]
fn hover_holds_expiry_and_resuming_still_terminates() {
	let mut queue = NotificationQueue::new();

	let note = Notification::new(
		NotificationId::new("note-1"),
		NotificationKey::new("k1"),
		NotificationTone::Info,
		"Info",
		1000,
	);
	queue.push(note);

	// Hold hover
	queue.set_hover_held(true);

	// At t = 10000, well past expiry, sweep does not evict while hover is held
	queue.sweep(10000);
	assert_eq!(queue.len(), 1);

	// Resume hover
	queue.set_hover_held(false);

	// Next sweep evicts expired note and terminates cleanly
	queue.sweep(10001);
	assert_eq!(queue.len(), 0);
}

#[test]
fn dismiss_all_and_dismiss_one_operations() {
	let mut queue = NotificationQueue::new();

	let id1 = NotificationId::new("n1");
	let id2 = NotificationId::new("n2");

	queue.push(Notification::new(
		id1.clone(),
		NotificationKey::new("k1"),
		NotificationTone::Ok,
		"T1",
		0,
	));
	queue.push(Notification::new(
		id2.clone(),
		NotificationKey::new("k2"),
		NotificationTone::Ok,
		"T2",
		0,
	));
	assert_eq!(queue.len(), 2);

	let dismissed = queue.dismiss(&id1);
	assert!(dismissed);
	assert_eq!(queue.len(), 1);
	assert_eq!(queue.entries()[0].id, id2);

	queue.dismiss_all();
	assert_eq!(queue.len(), 0);
}

#[test]
fn notification_settings_defaults_and_validation() {
	let defaults = NotificationSettings::default();
	assert!(!defaults.sound);
	assert!(!defaults.persist_errors);

	// Non-default values
	let sound_on = NotificationSettings::parse_setting("sound", "true").unwrap();
	assert!(sound_on.sound);

	let persist_on = NotificationSettings::parse_setting("persist_errors", "yes").unwrap();
	assert!(persist_on.persist_errors);

	// Invalid values are rejected
	assert!(NotificationSettings::parse_setting("sound", "not-a-bool").is_err());
	assert!(NotificationSettings::parse_setting("persist_errors", "invalid").is_err());
	assert!(NotificationSettings::parse_setting("unknown_key", "true").is_err());
}
