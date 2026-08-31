//! WHY. Out-of-view notification delivery must reach platform capabilities
//! (audio chime, OS system notification) only when explicitly enabled by user
//! preferences, and must carry the notification's deduplication key to allow
//! replacement rather than stacking.
//!
//! WHAT THIS DOES NOT CATCH. Native audio device playback or operating system
//! desktop notification center presentation, which belong to platform harness
//! integration tests.

use std::collections::BTreeSet;

use crate::{
	model::{Notification, NotificationId, NotificationKey, NotificationTone},
	store::{Effects, ShellEffect, Store},
};

#[test]
fn notification_with_each_setting_off_produces_no_platform_effect() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	// Default settings: chime=false, system_notice=false
	assert!(!store.replica.notifications.settings.chime);
	assert!(!store.replica.notifications.settings.system_notice);

	let note = Notification::new(
		NotificationId::new("n-1"),
		NotificationKey::new("k-1"),
		NotificationTone::Ok,
		"Test Notification",
		1000,
	);
	store.push_notification(note, &mut effects);

	assert!(
		!effects
			.shell
			.iter()
			.any(|e| matches!(e, ShellEffect::Chime { .. } | ShellEffect::SystemNotification { .. })),
		"platform effects produced despite both settings being disabled"
	);
}

#[test]
fn system_notice_on_produces_exactly_one_system_notice_with_dedupe_tag() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	store.set_notification_system_notice(true);

	let note = Notification::new(
		NotificationId::new("n-1"),
		NotificationKey::new("k-system-1"),
		NotificationTone::Warn,
		"System Warning",
		1000,
	);
	store.push_notification(note, &mut effects);

	let system_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::SystemNotification { .. }))
		.collect();

	assert_eq!(system_effects.len(), 1, "expected exactly one system notification effect");

	let chime_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::Chime { .. }))
		.collect();

	assert_eq!(chime_effects.len(), 0, "expected no chime effect when chime setting is off");

	match &system_effects[0] {
		ShellEffect::SystemNotification { tag, title, body } => {
			assert_eq!(tag.as_str(), "k-system-1");
			assert_eq!(title, "System Warning");
			assert_eq!(*body, None);
		},
		_ => unreachable!(),
	}
}

#[test]
fn chime_on_produces_exactly_one_chime_effect() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	store.set_notification_chime(true);

	let note = Notification::new(
		NotificationId::new("n-2"),
		NotificationKey::new("k-chime-1"),
		NotificationTone::Error,
		"Chime Error",
		2000,
	);
	store.push_notification(note, &mut effects);

	let chime_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::Chime { .. }))
		.collect();

	assert_eq!(chime_effects.len(), 1, "expected exactly one chime effect");

	let system_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::SystemNotification { .. }))
		.collect();

	assert_eq!(
		system_effects.len(),
		0,
		"expected no system notification effect when system_notice is off"
	);

	match &chime_effects[0] {
		ShellEffect::Chime { tone } => {
			assert_eq!(*tone, NotificationTone::Error);
		},
		_ => unreachable!(),
	}
}

#[test]
fn both_settings_on_produce_exactly_one_of_each_with_no_duplicates() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	store.set_notification_chime(true);
	store.set_notification_system_notice(true);

	let note = Notification::new(
		NotificationId::new("n-3"),
		NotificationKey::new("k-both-1"),
		NotificationTone::Info,
		"Both Enabled",
		3000,
	);
	store.push_notification(note, &mut effects);

	let system_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::SystemNotification { .. }))
		.collect();
	let chime_effects: Vec<_> = effects
		.shell
		.iter()
		.filter(|e| matches!(e, ShellEffect::Chime { .. }))
		.collect();

	assert_eq!(system_effects.len(), 1, "expected exactly one system notification effect");
	assert_eq!(chime_effects.len(), 1, "expected exactly one chime effect");
	assert_eq!(effects.shell.len(), 2, "expected no duplicate or unexpected effects");
}

#[test]
fn second_notification_with_same_key_produces_equal_tag_for_platform_replacement() {
	let mut store = Store::detached();
	let mut effects = Effects::default();

	store.set_notification_system_notice(true);

	let key = NotificationKey::new("reusable-task-key");

	let note1 = Notification::new(
		NotificationId::new("n-first"),
		key.clone(),
		NotificationTone::Info,
		"Task In Progress",
		1000,
	);
	store.push_notification(note1, &mut effects);

	let note2 = Notification::new(
		NotificationId::new("n-second"),
		key.clone(),
		NotificationTone::Ok,
		"Task Finished",
		2000,
	);
	store.push_notification(note2, &mut effects);

	let system_effects: Vec<_> = effects
		.shell
		.iter()
		.filter_map(|e| match e {
			ShellEffect::SystemNotification { tag, title, .. } => Some((tag.clone(), title.clone())),
			_ => None,
		})
		.collect();

	assert_eq!(system_effects.len(), 2);
	assert_eq!(
		system_effects[0].0, system_effects[1].0,
		"tags must match so platform replaces instead of stacking"
	);
	assert_eq!(system_effects[0].0.as_str(), "reusable-task-key");
	assert_eq!(system_effects[0].1, "Task In Progress");
	assert_eq!(system_effects[1].1, "Task Finished");
}

#[test]
fn sweep_shell_effect_variants_from_source_and_assert_notification_effects() {
	// Parse ShellEffect variants directly from store/mod.rs source
	let src = include_str!("../mod.rs");
	let enum_start = src
		.find("pub enum ShellEffect {")
		.expect("ShellEffect enum must exist in store/mod.rs");
	let enum_body = &src[enum_start..];
	let enum_end = enum_body
		.find("\n}\n")
		.expect("ShellEffect enum closing brace must exist");
	let enum_content = &enum_body[..enum_end];

	let mut all_variants = BTreeSet::new();
	for line in enum_content.lines() {
		let trimmed = line.trim();
		if trimmed.starts_with("pub enum")
			|| trimmed.is_empty()
			|| trimmed.starts_with("//")
			|| trimmed == "}"
		{
			continue;
		}
		// Extract variant identifier (e.g. "Focus(FocusTarget),", "ChooseAttachments
		// {", "QuitWindow,")
		let ident = trimmed
			.split(&['(', '{', ','][..])
			.next()
			.unwrap_or("")
			.trim();
		if !ident.is_empty() && ident.chars().next().unwrap_or(' ').is_uppercase() {
			all_variants.insert(ident.to_string());
		}
	}

	// Assert that all known ShellEffect variants were parsed
	let expected_variants: BTreeSet<String> = [
		"Focus",
		"ChooseAttachments",
		"QuitWindow",
		"CopyText",
		"RequestPaste",
		"RevealSelection",
		"RevealFile",
		"ScrollTranscriptToLatest",
		"ScrollTranscriptToOldest",
		"Notify",
		"SystemNotification",
		"Chime",
	]
	.into_iter()
	.map(String::from)
	.collect();

	assert_eq!(
		all_variants, expected_variants,
		"ShellEffect variants parsed from source do not match expected set"
	);

	// Variants that notification dispatch is designed to produce:
	let notification_variants: BTreeSet<String> = ["SystemNotification", "Chime"]
		.into_iter()
		.map(String::from)
		.collect();

	// Variants that notification dispatch deliberately does not produce:
	let non_notification_variants: BTreeSet<String> = all_variants
		.difference(&notification_variants)
		.cloned()
		.collect();

	let expected_non_notification: BTreeSet<String> = [
		"Focus",
		"ChooseAttachments",
		"QuitWindow",
		"CopyText",
		"RequestPaste",
		"RevealSelection",
		"RevealFile",
		"ScrollTranscriptToLatest",
		"ScrollTranscriptToOldest",
		"Notify",
	]
	.into_iter()
	.map(String::from)
	.collect();

	assert_eq!(
		non_notification_variants, expected_non_notification,
		"non-notification ShellEffect variants do not match expected opt-out set"
	);
}
