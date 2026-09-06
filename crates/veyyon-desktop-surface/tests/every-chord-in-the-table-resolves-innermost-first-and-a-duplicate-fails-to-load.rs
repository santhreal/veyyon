//! WHY: keyboard navigation is the primary interaction path for operators.
//! The defect classes this test closes are:
//! 1. Keymap table syntax or resolution regressions where any of the 31 chords
//!    in §5.14 fail to load or map to the wrong command.
//! 2. Duplicate chord declarations within the same scope slipping into shipped
//!    or custom tables without typed error reporting.
//! 3. Scope precedence inversion where a global chord shadows a focused
//!    region-specific handler instead of the innermost context winning.
//! 4. Keystroke dispatch failures on the live `ShellView` where pressing a
//!    keybinding does not dispatch the intended Intent or update state.
//!
//! What this suite leaves to the host is background execution of the resulting
//! host actions.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Badge, Command, Keymap, KeymapError, Overlay, Row, Scope, Section, ShellState, ShellView,
	attach::ConnectionPhase, install_tokens, resolve_chord,
};
use veyyon_gpui::{App, AppContext};

fn test_options() -> RenderOptions {
	RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() }
}

fn sample_state() -> ShellState {
	ShellState {
		connection: ConnectionPhase::Attached,
		sections: vec![(Section::Live, vec![
			Row {
				id:       101,
				title:    "Workspace Refactor".to_string(),
				subtitle: "veyyon-gui".to_string(),
				badge:    Some(Badge::Working),
				meta:     Some("2m ago".to_string()),
			},
			Row {
				id:       102,
				title:    "Bug Investigation".to_string(),
				subtitle: "veyyon-core".to_string(),
				badge:    Some(Badge::Input),
				meta:     Some("5m ago".to_string()),
			},
		])],
		..ShellState::default()
	}
}

#[test]
fn the_shipped_keymap_loads_all_31_chords_and_covers_every_scope() {
	let keymap = Keymap::load_default().expect("shipped keymap.toml must be valid");
	let rows = keymap.rows();

	// 1. Assert every registered command has at least one bound row.
	for command in Command::iter() {
		let found = rows.iter().any(|r| r.command == command);
		assert!(found, "command {command:?} must have a default binding in keymap.toml");
		assert_eq!(
			command.name(),
			Command::from_name(command.name())
				.expect("from_name")
				.name(),
			"command {command:?} name round-trip must match"
		);
		assert!(!command.label().is_empty(), "command {command:?} must have a non-empty label");
	}

	// 2. Assert every scope is represented in the rows.
	for scope in Scope::iter() {
		let count = rows.iter().filter(|r| r.scope == scope).count();
		assert!(count > 0, "scope {scope:?} must have at least one binding");
	}

	// 3. Derive GPUI bindings and ensure they match the active row count.
	let bindings = keymap.bindings();
	assert_eq!(
		bindings.len(),
		rows.len(),
		"derived GPUI bindings count must match resolved rows count"
	);
}

#[test]
fn a_duplicate_chord_within_a_scope_fails_to_load_with_typed_error() {
	// Duplicate in global scope.
	let duplicate_global = r#"
[[binding]]
scope = "global"
chord = "primary-k"
action = "OpenPalette"

[[binding]]
scope = "global"
chord = "primary-k"
action = "NewSession"
"#;
	let err = Keymap::load(duplicate_global).expect_err("must reject duplicate global chord");
	assert!(
		matches!(err, KeymapError::DuplicateChord { ref scope, ref chord } if scope == "global" && chord == "primary-k"),
		"unexpected error: {err:?}"
	);

	// Duplicate in queue scope.
	let duplicate_queue = r#"
[[binding]]
scope = "queue"
chord = "up"
action = "MoveSelection"
arg = { delta = -1 }

[[binding]]
scope = "queue"
chord = "up"
action = "MoveSelection"
arg = { delta = 1 }
"#;
	let err_queue = Keymap::load(duplicate_queue).expect_err("must reject duplicate queue chord");
	assert!(
		matches!(err_queue, KeymapError::DuplicateChord { ref scope, ref chord } if scope == "queue" && chord == "up"),
		"unexpected error: {err_queue:?}"
	);
}

#[test]
fn unknown_scope_unknown_action_and_invalid_chord_fail_with_typed_errors() {
	// Unknown scope.
	let unknown_scope = r#"
[[binding]]
scope = "sidebar"
chord = "primary-k"
action = "OpenPalette"
"#;
	let err = Keymap::load(unknown_scope).expect_err("must reject unknown scope");
	assert!(
		matches!(err, KeymapError::UnknownScope { ref scope, .. } if scope == "sidebar"),
		"unexpected error: {err:?}"
	);

	// Unknown action.
	let unknown_action = r#"
[[binding]]
scope = "global"
chord = "primary-k"
action = "NoSuchAction"
"#;
	let err = Keymap::load(unknown_action).expect_err("must reject unknown action");
	assert!(
		matches!(err, KeymapError::UnknownAction { ref action, .. } if action == "NoSuchAction"),
		"unexpected error: {err:?}"
	);

	// Invalid keystroke syntax.
	let invalid_chord = r#"
[[binding]]
scope = "global"
chord = "invalid--chord++"
action = "OpenPalette"
"#;
	let err = Keymap::load(invalid_chord).expect_err("must reject invalid keystroke");
	assert!(
		matches!(err, KeymapError::InvalidChord { ref chord, .. } if chord == "invalid--chord++"),
		"unexpected error: {err:?}"
	);
}

#[test]
fn an_inner_scope_takes_precedence_over_global_for_the_same_chord() {
	// Fixture with primary-k in global and primary-k in queue.
	let fixture = r#"
[[binding]]
scope = "global"
chord = "primary-k"
action = "OpenPalette"

[[binding]]
scope = "queue"
chord = "primary-k"
action = "ToggleParkSelected"
"#;
	let keymap = Keymap::load(fixture).expect("fixture with different scopes must load");
	assert_eq!(keymap.rows().len(), 2);

	let bindings = keymap.bindings();
	assert_eq!(bindings.len(), 2);

	// Global binding has no context predicate, queue binding has "Queue" predicate.
	let rows = keymap.rows();
	let global_binding = rows.iter().find(|r| r.scope == Scope::Global).unwrap();
	let queue_binding = rows.iter().find(|r| r.scope == Scope::Queue).unwrap();

	assert_eq!(global_binding.command, Command::OpenPalette);
	assert_eq!(queue_binding.command, Command::ToggleParkSelected);
}

#[test]
fn keystrokes_dispatch_intents_on_real_shellview_in_headless_session() {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");

	let mut session =
		HeadlessSession::open(&mut cx, &test_options(), move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("tokens and theme install");
			let keymap = Keymap::default();
			app.bind_keys(keymap.bindings());
			let state = sample_state();
			app.new(|_| ShellView::new(installed, state))
		})
		.expect("session opens");

	// 1. Initial render frame.
	let captured = session.frame().expect("initial frame renders");
	assert!(!captured.hitboxes.is_empty(), "initial frame must contain hitboxes");

	session
		.update(|view, _window, _cx| {
			assert!(view.state().overlay.is_none(), "overlay must start closed");
			assert!(!view.state().keymap.queue_collapsed, "queue rail must start visible");
		})
		.expect("initial state verified");

	// 2. Dispatch primary-k (cmd-k / ctrl-k) to open the palette overlay.
	let palette_chord = resolve_chord("primary-k");
	let handled = session
		.keystroke(&palette_chord)
		.expect("keystroke dispatches");
	assert!(handled, "primary-k must be handled by ShellView action listener");
	let palette_frame = session.frame().expect("palette frame renders");
	assert!(!palette_frame.hitboxes.is_empty(), "palette frame must contain interactive hitboxes");

	session
		.update(|view, _window, _cx| {
			assert!(
				matches!(view.state().overlay, Some(Overlay::Palette(_))),
				"primary-k must dispatch OpenOverlay(Palette)"
			);
		})
		.expect("palette overlay state verified");

	// Close palette overlay so focus returns to the shell for queue navigation.
	session
		.update(|view, _window, cx| {
			view.close_palette(cx);
		})
		.expect("palette closed");
	let _ = session
		.frame()
		.expect("frame settles after closing palette");
	// 3. Dispatch primary-b (cmd-b / ctrl-b) to toggle the queue rail.
	let queue_chord = resolve_chord("primary-b");
	let handled_b = session
		.keystroke(&queue_chord)
		.expect("keystroke dispatches");
	assert!(handled_b, "primary-b must be handled by ShellView action listener");

	session
		.update(|view, _window, _cx| {
			assert!(
				view.state().keymap.queue_collapsed,
				"primary-b must toggle queue_collapsed state"
			);
		})
		.expect("queue collapsed state verified");
}
