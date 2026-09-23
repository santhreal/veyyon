//! WHY THIS SUITE EXISTS
//!
//! Choosing a theme in the window did nothing in every build that offered it.
//! `SelectTheme` was mapped to `SetSetting { key: "theme" }`, a key the host's
//! schema does not have, so the host answered `INVALID_SETTING` and the row
//! never became active. `LoadThemes` read the same absent key and answered
//! `"dark"` whatever was configured, so the refusal was invisible: the list
//! came back looking settled on a theme nobody had chosen.
//!
//! A setting key is an open string almost everywhere, because the sheet the
//! host sends supplies it and `SettingChanged` passes it back untouched. The
//! defect is the other kind: a key the window writes itself, which nothing
//! upstream has checked. That one is closed, and the census in
//! `a-vocabulary-the-host-closed-is-sent-in-the-spelling-it-accepts.rs` cannot
//! see it, because it classifies `SetSetting.key` as open for the passthrough
//! case and is right to.
//!
//! THE CLASS THIS CLOSES: an intent that writes a setting key by hand. Every
//! sample intent is driven through `actions_for`, the keys that did not come
//! from the intent itself are collected, and the set is pinned by exact
//! equality, so an intent that starts naming a setting turns this red until
//! the name is recorded here and checked against the host's schema. The two
//! ground keys are pinned by name and by which ground each one carries, so
//! swapping them, or collapsing both onto one, fails.
//!
//! WHAT IT DOES NOT CATCH: that the host's schema still spells these two keys
//! this way. That is the other side of the wire and is pinned there, by
//! `a-setting-written-from-the-window-reaches-what-is-already-running.test.ts`,
//! which reads both keys back off the running store through `LoadThemes`.

mod support;

use std::collections::BTreeSet;

use support::{intent_samples::every_sample_intent, session};
use veyyon_desktop::{SessionIndex, actions_for};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostAction, QueuePartition, SessionId, Store,
};
use veyyon_desktop_surface::Intent;

/// Every setting key an intent writes itself rather than passing through.
///
/// A key reaching the host under a name its schema does not have is refused,
/// and nothing in the window reads the refusal, so the control is inert while
/// still drawing as though it worked.
const HAND_WRITTEN_KEYS: [&str; 2] = ["theme.dark", "theme.light"];

fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let mut index = SessionIndex::new();
	let _ = index.row_of(&id);
	(store, index)
}

/// The key an intent carried, when it carried one. A key equal to this came
/// from upstream and is the host's own; anything else the window wrote.
fn key_carried_by(intent: &Intent) -> Option<&str> {
	match intent {
		Intent::SettingChanged { key, .. } | Intent::ResetSetting(key) => Some(key),
		_ => None,
	}
}

#[test]
fn a_setting_key_the_window_writes_itself_is_one_this_suite_records() {
	let mut written = BTreeSet::new();
	for intent in every_sample_intent() {
		let (mut store, index) = seeded();
		let carried = key_carried_by(&intent).map(ToOwned::to_owned);
		for action in actions_for(&intent, &index, &mut store) {
			let HostAction::SetSetting { key, .. } = action else {
				continue;
			};
			if carried.as_deref() == Some(key.as_str()) {
				continue;
			}
			written.insert(key);
		}
	}

	let recorded: BTreeSet<String> = HAND_WRITTEN_KEYS.iter().map(|k| (*k).to_owned()).collect();
	assert_eq!(
		written, recorded,
		"an intent names a setting key the window wrote itself. Record it above, and check the name \
		 against the host's settings schema: a key the schema does not have is refused, and the \
		 control that sent it goes on drawing as though it worked."
	);
}

#[test]
fn a_theme_is_written_to_the_ground_it_is_drawn_on() {
	for (dark, expected) in [(true, "theme.dark"), (false, "theme.light")] {
		let (mut store, index) = seeded();
		let intent = Intent::SelectTheme { id: "aurora".to_owned(), dark };

		let actions = actions_for(&intent, &index, &mut store);

		let key = actions.iter().find_map(|action| match action {
			HostAction::SetSetting { key, value } => {
				assert_eq!(value, &serde_json::Value::String("aurora".to_owned()));
				Some(key.as_str())
			},
			_ => None,
		});
		assert_eq!(
			key,
			Some(expected),
			"a theme drawn on one ground is configured for that ground: choosing a dark theme leaves \
			 the light one alone, and the reverse"
		);
		assert!(
			actions
				.iter()
				.any(|action| matches!(action, HostAction::LoadThemes)),
			"the list is read again after the write, or the row it settled on stays unmarked"
		);
	}
}
