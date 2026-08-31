//! WHY. The notification stack must bound visible entries to prevent window
//! occlusion, ensure newest entries sit closest to the edge, correctly map all
//! tone variants, and observe user notification sound and error persistence
//! preferences.
//!
//! WHAT THIS DOES NOT CATCH. Operating system level audio output and window
//! manager layer stacking, which belong to native platform integration tests.

use std::collections::HashSet;

use veyyon_gui_core::{
	model::{Notification, NotificationId, NotificationKey, NotificationTone},
	store::{Effects, ShellEffect, Store},
};
use veyyon_gui_kit::ui::Tone;

use super::{
	MAX_VISIBLE_TOASTS,
	owners::{StackChrome, stack_control, toast_control, toast_owner},
	tone_of,
};

#[test]
fn tone_mapping_covers_every_core_tone() {
	for tone in NotificationTone::ALL {
		let mapped = tone_of(tone);
		match tone {
			NotificationTone::Ok => assert_eq!(mapped, Tone::Ok),
			NotificationTone::Warn => assert_eq!(mapped, Tone::Warn),
			NotificationTone::Error => assert_eq!(mapped, Tone::Danger),
			NotificationTone::Info => assert_eq!(mapped, Tone::Plain),
		}
	}
}

#[test]
fn stack_bounds_visible_count_and_calculates_overflow() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	// 0 entries
	assert_eq!(store.replica.notifications.len(), 0);

	// 3 entries (under MAX_VISIBLE_TOASTS = 4)
	for i in 0..3 {
		let note = Notification::new(
			NotificationId::new(format!("n-{i}")),
			NotificationKey::new(format!("k-{i}")),
			NotificationTone::Info,
			format!("Title {i}"),
			1000 + i as u64,
		);
		store.push_notification(note, &mut effects);
	}

	assert_eq!(store.replica.notifications.len(), 3);
	let entries = store.replica.notifications.entries();
	let visible = entries.len().min(MAX_VISIBLE_TOASTS);
	let overflow = entries.len().saturating_sub(MAX_VISIBLE_TOASTS);
	assert_eq!(visible, 3);
	assert_eq!(overflow, 0);

	// Push 7 more (total 10 entries)
	for i in 3..10 {
		let note = Notification::new(
			NotificationId::new(format!("n-{i}")),
			NotificationKey::new(format!("k-{i}")),
			NotificationTone::Info,
			format!("Title {i}"),
			1000 + i as u64,
		);
		store.push_notification(note, &mut effects);
	}

	assert_eq!(store.replica.notifications.len(), 10);
	let entries = store.replica.notifications.entries();
	let visible = entries.len().min(MAX_VISIBLE_TOASTS);
	let overflow = entries.len().saturating_sub(MAX_VISIBLE_TOASTS);
	assert_eq!(visible, 4);
	assert_eq!(overflow, 6);

	// Visible entries are the most recent (newest)
	let visible_slice = &entries[entries.len() - visible..];
	assert_eq!(visible_slice[0].id.as_str(), "n-6");
	assert_eq!(visible_slice[3].id.as_str(), "n-9");
}

#[test]
fn stack_control_keys_and_toast_keys_are_distinct() {
	let mut keys = HashSet::new();

	for chrome in StackChrome::ALL {
		let key = stack_control(chrome);
		assert!(keys.insert(key), "Duplicate stack control key for {:?}", chrome);
	}

	for i in 0..20 {
		let id = NotificationId::new(format!("toast-{i}"));
		let root_key = toast_owner(&id);
		assert!(keys.insert(root_key), "Duplicate toast root key for {:?}", id);

		for slot in veyyon_gui_kit::ui::ToastSlot::ALL {
			let slot_key = toast_control(&id, slot);
			assert!(keys.insert(slot_key), "Duplicate slot key for {:?}-{:?}", id, slot);
		}
	}
}

#[test]
fn notification_settings_change_observable_behavior() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	// 1. Chime setting:
	// Default: chime is false -> no ShellEffect::Chime is produced
	let note1 = Notification::new(
		NotificationId::new("s-1"),
		NotificationKey::new("sk-1"),
		NotificationTone::Ok,
		"Chime test off",
		1000,
	);
	store.push_notification(note1, &mut effects);
	assert!(
		!effects
			.shell
			.iter()
			.any(|e| matches!(e, ShellEffect::Chime { .. }))
	);

	// Turn chime ON
	store.set_notification_chime(true);
	let note2 = Notification::new(
		NotificationId::new("s-2"),
		NotificationKey::new("sk-2"),
		NotificationTone::Warn,
		"Chime test on",
		2000,
	);
	store.push_notification(note2, &mut effects);
	assert!(
		effects
			.shell
			.iter()
			.any(|e| matches!(e, ShellEffect::Chime { tone: NotificationTone::Warn })),
		"Chime effect was not scheduled when chime setting was enabled"
	);

	// 2. System notice setting:
	// Default: system_notice is false
	effects.shell.clear();
	store.set_notification_system_notice(false);
	let note3 = Notification::new(
		NotificationId::new("sys-1"),
		NotificationKey::new("sys-k-1"),
		NotificationTone::Info,
		"System notice test off",
		2500,
	);
	store.push_notification(note3, &mut effects);
	assert!(
		!effects
			.shell
			.iter()
			.any(|e| matches!(e, ShellEffect::SystemNotification { .. }))
	);

	// Turn system_notice ON
	store.set_notification_system_notice(true);
	let note4 = Notification::new(
		NotificationId::new("sys-2"),
		NotificationKey::new("sys-k-2"),
		NotificationTone::Info,
		"System notice test on",
		2600,
	);
	store.push_notification(note4, &mut effects);
	assert!(
		effects
			.shell
			.iter()
			.any(|e| matches!(e, ShellEffect::SystemNotification { tag, title, .. } if tag.as_str() == "sys-k-2" && title == "System notice test on")),
		"System notification effect was not scheduled when system_notice setting was enabled"
	);
	// 2. Error persistence setting:
	// Default: persist_errors is false -> mark_read dismisses the error
	let err1 = NotificationId::new("e-1");
	store.push_notification(
		Notification::new(
			err1.clone(),
			NotificationKey::new("ek-1"),
			NotificationTone::Error,
			"Err 1",
			3000,
		),
		&mut effects,
	);
	assert!(
		store
			.replica
			.notifications
			.entries()
			.iter()
			.any(|n| n.id == err1)
	);
	store.mark_notification_read(&err1);
	assert!(
		!store
			.replica
			.notifications
			.entries()
			.iter()
			.any(|n| n.id == err1)
	);

	// Turn persist_errors ON -> mark_read keeps the error in queue
	store.set_notification_persist_errors(true);
	let err2 = NotificationId::new("e-2");
	store.push_notification(
		Notification::new(
			err2.clone(),
			NotificationKey::new("ek-2"),
			NotificationTone::Error,
			"Err 2",
			4000,
		),
		&mut effects,
	);
	store.mark_notification_read(&err2);
	let entry = store
		.replica
		.notifications
		.entries()
		.iter()
		.find(|n| n.id == err2);
	assert!(entry.is_some(), "Error notification was dismissed despite persist_errors enabled");
	assert!(entry.unwrap().read, "Notification was not marked as read");
}
