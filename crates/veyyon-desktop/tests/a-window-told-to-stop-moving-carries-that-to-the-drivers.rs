//! WHY THIS SUITE EXISTS
//!
//! `display.transitions` is the setting an operator turns structural motion
//! off with, and the desktop read it nowhere. Every motion driver resolved
//! against a flag only the offscreen scene renderer and a unit test ever set,
//! so the window animated whatever the operator had chosen and the setting was
//! a dead knob on the appearance page.
//!
//! THE CLASS THIS CLOSES:
//! 1. The setting arriving in a snapshot and reaching no field a frame reads:
//!    the projection is driven through the real reducer, from the section the
//!    host sends.
//! 2. The value being read once, at construction, so a snapshot arriving after
//!    the window opened changes nothing: the second test changes the state of a
//!    live window and requires the next frame to carry it.
//! 3. A value the schema does not declare being read as a third meaning: only
//!    `off` reduces, and the set of values that do is pinned by exact equality.
//!
//! WHAT IT DOES NOT CATCH:
//! What each driver does once it is told to reduce, which
//! `veyyon-desktop-motion`'s `reduced_motion_contract.rs` pins per role and
//! `a-float-reverses-without-jumping-and-settles.rs` pins for the float; and
//! whether the host declares the two values this maps, which
//! `settings-themes-and-keybindings-are-configured-and-persisted.test.ts`
//! asserts off the schema itself.

mod support;

use std::collections::HashMap;

use serde_json::{Value, json};
use support::{NOW_MS, fields::driven};
use veyyon_desktop::{SessionIndex, TRANSITIONS_SETTING, project, reduced_motion};
use veyyon_desktop_model::{
	HostEvent, SettingEntry, SettingKind, SettingsView, SnapshotSection, Store, reduce,
};
use veyyon_desktop_surface::{ShellState, fixture};

/// The values `display.transitions` is reported with, and one the schema does
/// not declare, so the reading of an unknown value is stated rather than
/// assumed.
const REPORTED_VALUES: [&str; 3] = ["on", "off", "shimmer"];

/// The values that mean the operator turned motion off. Pinned by exact
/// equality: a value that starts or stops reducing turns this red until the
/// desktop's reader and this row agree.
const VALUES_THAT_REDUCE: [&str; 1] = ["off"];

/// The settings section the host sends, holding `display.transitions` at
/// `value`.
fn transitions_reported(value: &str) -> SnapshotSection {
	let mut settings = SettingsView::new();
	settings.insert(TRANSITIONS_SETTING.to_owned(), SettingEntry {
		value:       json!(value),
		default:     json!("on"),
		source:      "profile".to_owned(),
		kind:        SettingKind::Enum,
		label:       Some("Transitions".to_owned()),
		description: None,
		tab:         Some("appearance".to_owned()),
		group:       Some("Display".to_owned()),
		values:      vec!["on".to_owned(), "off".to_owned()],
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	});
	SnapshotSection::Settings(settings)
}

/// What one settings snapshot leaves on the state a frame draws, through the
/// reducer and the projection the window runs.
fn projected(section: Option<SnapshotSection>) -> bool {
	let mut store = Store::default();
	if let Some(section) = section {
		let _damage = reduce(&mut store, HostEvent::Snapshot(section));
	}
	let mut state = ShellState::default();
	let mut index = SessionIndex::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(
		state.reduced_motion,
		reduced_motion(&store),
		"the projection and the reader disagree about the same store",
	);
	state.reduced_motion
}

#[test]
fn the_transitions_setting_the_host_reports_is_what_the_next_frame_resolves_against() {
	assert!(
		!projected(None),
		"a window that has heard no settings yet reduced motion, which is not the schema's default",
	);

	let reducing: Vec<&str> = REPORTED_VALUES
		.into_iter()
		.filter(|value| projected(Some(transitions_reported(value))))
		.collect();
	assert_eq!(
		reducing, VALUES_THAT_REDUCE,
		"the values that turn motion off are not the ones the desktop maps: a value the schema does \
		 not declare must leave the window moving",
	);
}

#[test]
fn a_settings_snapshot_that_arrives_after_the_window_opened_reaches_the_driver() {
	// The driver is constructed before any snapshot arrives, so a window that
	// read the setting once at construction passes every check that only ever
	// opens with it already set.
	driven(ShellState { reduced_motion: false, ..fixture::populated() }, |session| {
		assert!(
			!session
				.update(|view, _window, _cx| view.rail_motion().is_reduced_motion())
				.expect("the view is live"),
			"a window opened with motion on told its driver to reduce",
		);

		session
			.update(|view, _window, cx| {
				view.state_mut().reduced_motion = true;
				cx.notify();
			})
			.expect("the view is live");
		session
			.frame()
			.expect("the frame after the snapshot renders");

		assert!(
			session
				.update(|view, _window, _cx| view.rail_motion().is_reduced_motion())
				.expect("the view is live"),
			"the setting reached the state a frame draws and stopped there: every motion driver \
			 resolves against the rail's policy, so a snapshot that does not reach it moves a window \
			 whose operator asked it not to",
		);
	});
}

/// A value of another JSON type is not a string, so the reader answers with
/// the schema's default rather than with a truthiness of its own.
#[test]
fn a_transitions_value_that_is_not_a_string_leaves_the_window_moving() {
	for value in [json!(true), json!(0), Value::Null] {
		let mut settings = SettingsView::new();
		settings.insert(TRANSITIONS_SETTING.to_owned(), SettingEntry {
			value,
			default: json!("on"),
			source: "profile".to_owned(),
			kind: SettingKind::Enum,
			label: None,
			description: None,
			tab: None,
			group: None,
			values: Vec::new(),
			options: Vec::new(),
			min: None,
			max: None,
			global: false,
			advanced: false,
			hidden: false,
		});
		assert!(
			!projected(Some(SnapshotSection::Settings(settings))),
			"a value that is not one of the schema's strings reduced motion",
		);
	}
}
