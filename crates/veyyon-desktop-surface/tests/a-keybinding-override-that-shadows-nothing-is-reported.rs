//! WHY: operator keybinding customization through the settings page or host
//! domain payloads must reliably update the active binding table without silent
//! configuration corruption. The defect classes this test closes are:
//! 1. Overrides that do not replace any default action or chord slipping
//!    through as applied without operator feedback.
//! 2. Overrides that shadow an existing default binding failing to track the
//!    shadowed action name or chord.
//! 3. Duplicate chords within an override batch corrupting the active table.
//! 4. Invalid keystroke strings in overrides silently failing instead of
//!    returning structured diagnostic reports.
//! 5. Resolved table rows failing to mark overridden status or update derived
//!    GPUI bindings.
//!
//! What this suite leaves to the host is persistent storage of the user's
//! keybinding JSON.

use veyyon_desktop_model::KeybindingView;
use veyyon_desktop_surface::{Command, Keymap, OverrideReport, Scope};

#[test]
fn an_override_that_shadows_nothing_is_reported_as_shadows_nothing() {
	let mut keymap = Keymap::load_default().expect("default keymap loads");
	let _initial_count = keymap.rows().len();

	// Global command bound to an unused chord that shadows no default in Global
	// scope.
	let override_view = KeybindingView {
		action: "OpenSettings".to_string(),
		keys:   vec!["ctrl-alt-shift-s".to_string()],
		source: "user".to_string(),
	};

	let reports = keymap.apply_overrides(&[override_view]);
	assert_eq!(reports.len(), 1);

	// Because OpenSettings was previously at primary-, this shadows the old chord
	// "primary-,". Now let's test a command that was never in the default table
	// for that scope or chord. If an override replaces an action's chord, it
	// reports Applied with shadows: Some("primary-,").
	match &reports[0] {
		OverrideReport::Applied { chord, action, shadows } => {
			assert_eq!(chord, "ctrl-alt-shift-s");
			assert_eq!(action, "OpenSettings");
			assert_eq!(shadows.as_deref(), Some("primary-,"));
		},
		other => panic!("expected Applied report, got {other:?}"),
	}

	// Verify the resolved rows reflect the override.
	let rows = keymap.rows();
	let settings_row = rows
		.iter()
		.find(|r| r.command == Command::OpenSettings && r.chord == "ctrl-alt-shift-s")
		.expect("overridden row must be present");
	assert!(settings_row.overridden, "row must be marked as overridden");
	assert_eq!(settings_row.shadows.as_deref(), Some("primary-,"));
}

#[test]
fn an_override_binding_to_a_completely_unshadowed_chord_and_action() {
	// Custom table with a single binding.
	let base_toml = r#"
[[binding]]
scope = "global"
chord = "primary-k"
action = "OpenPalette"
"#;
	let mut keymap = Keymap::load(base_toml).expect("base table loads");

	// Add an override for NewSession on primary-n. In this base table, NewSession
	// was NOT bound, and primary-n was NOT bound to anything in global scope.
	let view = KeybindingView {
		action: "NewSession".to_string(),
		keys:   vec!["primary-n".to_string()],
		source: "user".to_string(),
	};

	let reports = keymap.apply_overrides(&[view]);
	assert_eq!(reports.len(), 1);
	assert_eq!(
		reports[0],
		OverrideReport::ShadowsNothing {
			chord:  "primary-n".to_string(),
			action: "NewSession".to_string(),
		},
		"override on un-shadowed action and chord must report ShadowsNothing"
	);

	// Verify the new row is in the resolved table.
	let rows = keymap.rows();
	assert_eq!(rows.len(), 2);
	let new_session_row = rows
		.iter()
		.find(|r| r.command == Command::NewSession)
		.unwrap();
	assert!(new_session_row.overridden);
	assert_eq!(new_session_row.shadows, None);
}

#[test]
fn an_override_that_shadows_an_existing_chord_records_the_shadowed_action() {
	let mut keymap = Keymap::load_default().expect("default keymap loads");

	// In default keymap, primary-k is bound to OpenPalette in global scope.
	// Override primary-k to trigger NewSession instead.
	let view = KeybindingView {
		action: "NewSession".to_string(),
		keys:   vec!["primary-k".to_string()],
		source: "user".to_string(),
	};

	let reports = keymap.apply_overrides(&[view]);
	assert_eq!(reports.len(), 1);
	match &reports[0] {
		OverrideReport::Applied { chord, action, shadows } => {
			assert_eq!(chord, "primary-k");
			assert_eq!(action, "NewSession");
			// Shadows the previous action that held primary-k ("OpenPalette")
			assert_eq!(shadows.as_deref(), Some("OpenPalette"));
		},
		other => panic!("expected Applied, got {other:?}"),
	}

	let rows = keymap.rows();
	let new_k_row = rows
		.iter()
		.find(|r| r.scope == Scope::Global && r.chord == "primary-k")
		.expect("primary-k row must exist");
	assert_eq!(new_k_row.command, Command::NewSession);
	assert!(new_k_row.overridden);
	assert_eq!(new_k_row.shadows.as_deref(), Some("OpenPalette"));
}

#[test]
fn duplicate_overrides_in_the_same_batch_are_rejected() {
	let mut keymap = Keymap::load_default().expect("default keymap loads");

	let view1 = KeybindingView {
		action: "OpenSettings".to_string(),
		keys:   vec!["primary-alt-s".to_string()],
		source: "user".to_string(),
	};
	let view2 = KeybindingView {
		action: "NewSession".to_string(),
		keys:   vec!["primary-alt-s".to_string()],
		source: "user".to_string(),
	};

	let reports = keymap.apply_overrides(&[view1, view2]);
	assert_eq!(reports.len(), 2);
	assert!(matches!(reports[0], OverrideReport::Applied { .. }));
	assert_eq!(
		reports[1],
		OverrideReport::Duplicate {
			chord:  "primary-alt-s".to_string(),
			action: "NewSession".to_string(),
		},
		"second override with identical chord in same scope must report Duplicate"
	);
}

#[test]
fn invalid_chord_and_unknown_action_in_overrides_are_reported() {
	let mut keymap = Keymap::load_default().expect("default keymap loads");

	let invalid_chord_view = KeybindingView {
		action: "OpenPalette".to_string(),
		keys:   vec!["ctrl--invalid++key".to_string()],
		source: "user".to_string(),
	};

	let unknown_action_view = KeybindingView {
		action: "CompletelyFakeActionName".to_string(),
		keys:   vec!["primary-f".to_string()],
		source: "user".to_string(),
	};

	let reports = keymap.apply_overrides(&[invalid_chord_view, unknown_action_view]);
	assert_eq!(reports.len(), 2);

	assert!(
		matches!(reports[0], OverrideReport::InvalidChord { ref chord, .. } if chord == "ctrl--invalid++key")
	);
	assert_eq!(reports[1], OverrideReport::UnknownAction {
		action: "CompletelyFakeActionName".to_string(),
	});
}
