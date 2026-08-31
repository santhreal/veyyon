//! WHY. Out-of-view notifications must reach the operating system notification
//! center and audio playback only when their respective settings are enabled.
//! Both settings default to off, operate independently, and an unavailable
//! audio player must report failure rather than pretending to play.
//!
//! WHAT THIS DOES NOT CATCH. Physical audio device driver output and native
//! operating system notification window manager presentation, which require
//! hardware peripherals and OS-level capture harnesses.

use std::sync::atomic::{AtomicBool, AtomicUsize};

use gpui::{SystemNotificationResponse, TestAppContext};
use veyyon_gui_core::{
	UiCommand,
	model::{Notification, NotificationId, NotificationKey, NotificationTone, SettingPath, Value},
};

use crate::{
	notice::{
		ChimeStatus, clear_last_response_tag, init, last_response_tag, perform_chime_with_state,
	},
	the_keyboard_reaches_every_route::open,
};

#[gpui::test]
fn system_notification_reaches_platform_when_enabled(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.update(|_, cx| {
		init(cx);
	});

	// Default: system_notice is false
	let default_shown = cx.shown_system_notifications().len();

	let note1 = Notification::new(
		NotificationId::new("n-off"),
		NotificationKey::new("key-off"),
		NotificationTone::Info,
		"Notice Disabled",
		1000,
	);

	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			let mut effects = veyyon_gui_core::store::Effects::default();
			let _ = shell.store.push_notification(note1, &mut effects);
			shell.perform_effects(effects, window, cx);
		});
	});
	cx.run_until_parked();

	assert_eq!(
		cx.shown_system_notifications().len(),
		default_shown,
		"system notification was shown while system_notice setting was off"
	);

	// Enable system_notice via UiCommand::EditSetting
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(
				UiCommand::EditSetting {
					path:  SettingPath("notifications.system_notice".to_string()),
					value: Value::Bool(true),
				},
				window,
				cx,
			);
		});
	});
	cx.run_until_parked();

	let note2 = Notification::new(
		NotificationId::new("n-on"),
		NotificationKey::new("key-on-123"),
		NotificationTone::Warn,
		"Build Succeeded",
		2000,
	);

	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			let mut effects = veyyon_gui_core::store::Effects::default();
			let _ = shell.store.push_notification(note2, &mut effects);
			shell.perform_effects(effects, window, cx);
		});
	});
	cx.run_until_parked();

	let shown = cx.shown_system_notifications();
	assert_eq!(
		shown.len(),
		default_shown + 1,
		"expected exactly one system notification to be shown"
	);

	let last_shown = shown.last().expect("must have shown notification");
	assert_eq!(
		last_shown.tag.as_ref(),
		"key-on-123",
		"notification tag must match store dedupe key"
	);
	assert_eq!(last_shown.title.as_ref(), "Build Succeeded", "notification title must match store");
}

#[gpui::test]
fn system_notification_response_callback_receives_tag(cx: &mut TestAppContext) {
	let (_shell, cx) = open(cx);

	cx.update(|_, cx| {
		init(cx);
	});

	clear_last_response_tag();
	assert_eq!(last_response_tag(), None);

	cx.simulate_system_notification_response(SystemNotificationResponse {
		tag:       "response-tag-test".into(),
		action_id: None,
	});
	cx.run_until_parked();

	assert_eq!(
		last_response_tag().as_deref(),
		Some("response-tag-test"),
		"response callback did not receive the simulated notification tag"
	);
}

#[gpui::test]
fn chime_with_no_player_performs_no_spawn_and_reports_unavailable_once(cx: &mut TestAppContext) {
	let (_shell, _cx) = open(cx);

	let unavailable_reported = AtomicBool::new(false);
	let spawn_error_reported = AtomicBool::new(false);
	let unavailable_count = AtomicUsize::new(0);

	// First call with no resolved player
	let status1 = perform_chime_with_state(
		None,
		NotificationTone::Info,
		&unavailable_reported,
		&spawn_error_reported,
		&unavailable_count,
	);
	assert_eq!(status1, ChimeStatus::Unavailable, "must return Unavailable when no player exists");
	assert_eq!(unavailable_count.load(std::sync::atomic::Ordering::Relaxed), 1);

	// Subsequent calls must not report again
	for _ in 0..5 {
		let status = perform_chime_with_state(
			None,
			NotificationTone::Error,
			&unavailable_reported,
			&spawn_error_reported,
			&unavailable_count,
		);
		assert_eq!(status, ChimeStatus::Unavailable, "must never claim Played when no player exists");
	}

	assert_eq!(
		unavailable_count.load(std::sync::atomic::Ordering::Relaxed),
		1,
		"unavailable status must be reported exactly once across repeated notifications"
	);
}

#[gpui::test]
fn both_settings_change_observable_behavior_independently(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);

	cx.update(|_, cx| {
		init(cx);
	});

	// Verify defaults
	cx.update(|_, cx| {
		shell.update(cx, |shell, _| {
			assert!(!shell.store.replica.notifications.settings.chime);
			assert!(!shell.store.replica.notifications.settings.system_notice);
			assert!(!shell.store.replica.notifications.settings.persist_errors);
		});
	});

	// Enable only chime
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(
				UiCommand::EditSetting {
					path:  SettingPath("notifications.chime".to_string()),
					value: Value::Bool(true),
				},
				window,
				cx,
			);
		});
	});
	cx.run_until_parked();

	cx.update(|_, cx| {
		shell.update(cx, |shell, _| {
			assert!(shell.store.replica.notifications.settings.chime);
			assert!(!shell.store.replica.notifications.settings.system_notice);
		});
	});

	// Enable system_notice and disable chime
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(
				UiCommand::EditSetting {
					path:  SettingPath("notifications.chime".to_string()),
					value: Value::Bool(false),
				},
				window,
				cx,
			);
			shell.perform(
				UiCommand::EditSetting {
					path:  SettingPath("notifications.system_notice".to_string()),
					value: Value::Bool(true),
				},
				window,
				cx,
			);
		});
	});
	cx.run_until_parked();

	cx.update(|_, cx| {
		shell.update(cx, |shell, _| {
			assert!(!shell.store.replica.notifications.settings.chime);
			assert!(shell.store.replica.notifications.settings.system_notice);
		});
	});
}
