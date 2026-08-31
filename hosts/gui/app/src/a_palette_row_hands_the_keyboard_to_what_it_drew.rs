//! WHY THIS SUITE EXISTS. Accepting a palette row ran its commands inside the
//! store, so the window never saw them. The keyboard was placed by inspecting
//! the command that arrived here, which for an acceptance is `AcceptPalette`
//! and never the `CloseTopOverlay` the row actually began with: the palette's
//! field left the tree with its overlay, the keyboard stayed on it, and gpui
//! then dispatched every later keystroke from an element nothing draws. The
//! window answered nothing at all until it was closed. Rows that changed the
//! route survived by luck, because a route transition places the keyboard for
//! its own reasons, which is why only the panel, appearance and tab rows looked
//! broken.
//!
//! THE CLASS. Not "accepting a row", but any state change that replaces the
//! surface holding the keyboard without arriving here as the command that did
//! it. Every row of every mode is swept, from the catalogue at run time, so a
//! verb added later is proven here or fails here; a mode added to
//! `PaletteMode::ALL` is swept the moment it exists. The two other members of
//! the class are covered as well: an overlay that is opened by a row rather
//! than by a chord, and an overlay dropped out of band when the request behind
//! it completes.
//!
//! WHAT IT DOES NOT CATCH. Which surface should hold the keyboard, only that a
//! drawn one does. `Overlay::keyboard` names the holder per variant and is
//! exhaustive, so a new overlay cannot omit one, but naming the wrong one
//! passes here and shows as a chord reaching the frame instead of a field.
//!
//! Nothing about appearance: the test platform has no display, so whether the
//! focused field is visible on screen is not observed here.

use gpui::TestAppContext;
use veyyon_gui_core::{
	UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{SessionId, SessionStatus, SessionSummary, Versioned, WorkspaceId},
	navigation::{Overlay, PaletteMode},
	palette,
};
use veyyon_gui_kit::input::Editor;

use crate::the_keyboard_reaches_every_route::{SECONDARY, open};

/// Every row a mode offers with an empty query, counted from the catalogue
/// rather than from a list written here.
fn row_count(mode: PaletteMode, cx: &mut TestAppContext) -> usize {
	let (shell, cx) = open(cx);
	shell.read_with(cx, |shell, _| {
		palette::results(&shell.store, mode, "")
			.groups
			.iter()
			.map(|group| group.items.len())
			.sum()
	})
}

#[gpui::test]
fn every_palette_row_leaves_the_window_answering(cx: &mut TestAppContext) {
	let mut swept = 0_usize;
	for mode in PaletteMode::ALL {
		for index in 0..row_count(mode, cx) {
			let (shell, cx) = open(cx);

			// Walked and accepted with the keys a reader presses, not by
			// dispatching the acceptance here: a field's own event reaches this
			// window without a window, which is half of what the defect was, so
			// a sweep that calls `perform` proves the other half only.
			cx.update(|window, cx| {
				shell.update(cx, |shell, cx| {
					shell.perform(UiCommand::OpenOverlay(Overlay::CommandPalette { mode }), window, cx);
				});
			});
			for _ in 0..index {
				cx.simulate_keystrokes("down");
			}
			assert_eq!(
				shell.read_with(cx, |shell, _| shell.store.frontend.palette_cursor),
				index,
				"the arrow keys do not reach the palette cursor in {mode:?}"
			);
			cx.simulate_keystrokes("enter");

			let before = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);
			cx.simulate_keystrokes(&format!("{SECONDARY}-b"));
			let after = shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open);

			assert_ne!(
				after, before,
				"row {index} of {mode:?} left the window deaf: the keyboard is on an element nothing \
				 draws"
			);
			swept += 1;
		}
	}

	// The sweep is only worth its name while the catalogue has rows in it: an
	// empty `results` would pass every assertion above by running none.
	assert!(swept > 20, "only {swept} rows were swept, so the catalogue came back empty");
}

#[gpui::test]
fn a_row_that_swaps_one_overlay_for_another_moves_the_keyboard_with_it(cx: &mut TestAppContext) {
	// The case a stack depth cannot see. "Rename session" closes the palette
	// and opens the rename sheet in one acceptance, so one overlay is open
	// before and after and only its identity says the drawn field changed.
	// Seeding the field is proven here too: the typed character lands beside
	// the current name, which is what makes the sheet a rename rather than a
	// blank field.
	let (shell, cx) = open(cx);
	cx.update(|_, cx| {
		shell.update(cx, |shell, _| {
			shell.bridge.apply(&mut shell.store, sessions());
		});
	});

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	cx.simulate_input("Rename session");
	cx.simulate_keystrokes("enter");

	let value = shell.read_with(cx, |shell, _| match shell.store.frontend.overlays.last() {
		Some(Overlay::RenameSession { value, .. }) => value.clone(),
		other => panic!("the row left {other:?} open instead of the rename sheet"),
	});

	cx.simulate_input("!");

	assert_eq!(
		shell.read_with(cx, |shell, cx| shell
			.handles
			.editors
			.rename_session
			.read(cx)
			.text()
			.to_owned()),
		format!("{value}!"),
		"the rename field neither took the keyboard nor started on the current name"
	);
}

#[gpui::test]
fn a_row_accepted_in_the_field_still_runs_the_effects_it_raised(cx: &mut TestAppContext) {
	// The other half of the same defect: a field's event reaches this window
	// with no window, so an effect that has to touch a surface cannot run where
	// the command was dispatched. Dropping them made every row whose work is an
	// effect — jumping the transcript, copying, quitting — do nothing at all
	// when it was accepted with the key a reader presses, while the same row
	// worked from a chord.
	let (shell, cx) = open(cx);
	assert!(
		shell.read_with(cx, |shell, cx| shell.handles.timeline.read(cx).follow.following),
		"the transcript does not start on the tail, so leaving it proves nothing"
	);

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	cx.simulate_input("Jump to oldest");
	cx.simulate_keystrokes("enter");

	assert!(
		!shell.read_with(cx, |shell, cx| shell.handles.timeline.read(cx).follow.following),
		"the row's effect never reached the transcript"
	);
}

#[gpui::test]
fn a_row_that_closes_the_panel_the_keyboard_was_in_does_not_take_it_along(cx: &mut TestAppContext) {
	// The variant that survives every fix built on remembering handles: the
	// keyboard starts in the sidebar's filter, the palette covers it, and the
	// accepted row closes the sidebar. Handing the keyboard back to what the
	// palette covered hands it to a field that went with the panel, and the
	// window is deaf again for a reason that has nothing to do with overlays.
	let (shell, cx) = open(cx);
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			Editor::focus(&shell.handles.editors.sessions, window, cx);
		});
	});
	assert!(
		shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open),
		"the sidebar is already shut, so closing it proves nothing"
	);

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	cx.simulate_input("Toggle sidebar");
	cx.simulate_keystrokes("enter");
	assert!(
		!shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open),
		"the row did not close the sidebar, so the field it held is still drawn"
	);

	cx.simulate_keystrokes(&format!("{SECONDARY}-b"));
	assert!(
		shell.read_with(cx, |shell, _| shell.store.frontend.panels.sidebar_open),
		"the window went deaf with the keyboard in a panel that closed"
	);
}

/// One session, so the rows that need a selected conversation are enabled: the
/// store selects it as the snapshot arrives.
fn sessions() -> HostEvent {
	let id = SessionId::new("session-1").expect("session id is not empty");
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned {
			revision: 1,
			value:    vec![SessionSummary {
				id,
				workspace: WorkspaceId::new("ws-1").expect("workspace id is not empty"),
				path: "/repo/session-1.json".to_owned(),
				cwd: "/repo".to_owned(),
				title: Some("Active session".to_owned()),
				parent_path: None,
				created_at_ms: 1_000,
				modified_at_ms: 2_000,
				message_count: 2,
				size_bytes: 64,
				first_message: Some("hello".to_owned()),
				searchable_messages: None,
				status: SessionStatus::Complete,
			}],
		},
		Vec::new(),
	))
}
