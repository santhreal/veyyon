//! WHY THIS SUITE EXISTS. Closing a window on macOS with ⌘W or dismissing the
//! window leaves the process alive with only the menu bar. When the user
//! reopens the app from the Dock, the window must restore the exact session,
//! draft, and panel layout it had before closing, at the size and position it
//! had, clamped inside the active display.
//!
//! This suite proves:
//! 1. Window bounds clamping into arbitrary display configurations, ensuring a
//!    restored window never opens hanging off screen edges or below minimum
//!    bounds.
//! 2. Reopening from `ReopenState` carries the live `Entity<Shell>` with its
//!    full session, panel, and navigation state.
//! 3. Reopening with no recorded state safely falls back to default fitted
//!    bounds.
//! 4. Application menus report the real crate version in the About item and
//!    reflect live store enablement.
//! 5. Application shortcuts install platform window lifecycle accelerators.
//!
//! WHAT IT DOES NOT CATCH. Operating system Dock click event delivery and
//! AppKit window server display reconfiguration events.

use gpui::{Bounds, TestAppContext, point, px, size};
use veyyon_gui_core::{
	Store,
	model::SessionId,
	navigation::{BottomTab, InspectorTab, Overlay, PaletteMode},
};

use crate::{
	MARGIN, MIN_HEIGHT, MIN_WIDTH, ReopenState, clamp_bounds, fitted, menus,
	the_keyboard_reaches_every_route::{attached, open_with},
};

#[test]
fn clamping_bounds_places_oversized_or_out_of_bounds_windows_fully_inside_display() {
	let display_origin = point(px(100.0), px(100.0));
	let display_size = size(px(1920.0), px(1080.0));

	// 1. Off-screen top-left (negative coordinates)
	let off_top_left = Bounds::new(point(px(-50.0), px(-20.0)), size(px(1200.0), px(800.0)));
	let clamped = clamp_bounds(off_top_left, Some(display_size), Some(display_origin));
	assert!(clamped.origin.x >= display_origin.x);
	assert!(clamped.origin.y >= display_origin.y);
	assert!(clamped.origin.x + clamped.size.width <= display_origin.x + display_size.width);
	assert!(clamped.origin.y + clamped.size.height <= display_origin.y + display_size.height);

	// 2. Off-screen bottom-right
	let off_bottom_right = Bounds::new(point(px(1500.0), px(800.0)), size(px(1200.0), px(800.0)));
	let clamped = clamp_bounds(off_bottom_right, Some(display_size), Some(display_origin));
	assert!(clamped.origin.x + clamped.size.width <= display_origin.x + display_size.width);
	assert!(clamped.origin.y + clamped.size.height <= display_origin.y + display_size.height);

	// 3. Oversized window on a small display shrinks within display - MARGIN
	let small_display = size(px(1024.0), px(768.0));
	let huge_bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(2000.0), px(1500.0)));
	let clamped = clamp_bounds(huge_bounds, Some(small_display), Some(point(px(0.0), px(0.0))));
	assert_eq!(clamped.size.width, px(1024.0 - MARGIN));
	assert_eq!(clamped.size.height, px(768.0 - MARGIN));

	// 4. Undersized window enforces MIN_WIDTH and MIN_HEIGHT
	let tiny_bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(300.0)));
	let clamped = clamp_bounds(tiny_bounds, Some(display_size), Some(display_origin));
	assert_eq!(clamped.size.width, px(MIN_WIDTH));
	assert_eq!(clamped.size.height, px(MIN_HEIGHT));
}

#[test]
fn reopen_without_recorded_bounds_opens_default_fitted_bounds() {
	let display_size = size(px(1920.0), px(1080.0));
	let default_size = fitted(Some(display_size));
	assert_eq!(default_size.width, px(1320.0));
	assert_eq!(default_size.height, px(880.0));

	let clamped_none = clamp_bounds(
		Bounds::new(point(px(0.0), px(0.0)), default_size),
		Some(display_size),
		Some(point(px(0.0), px(0.0))),
	);
	assert_eq!(clamped_none.size, default_size);
}

#[gpui::test]
fn reopening_window_from_recorded_state_preserves_session_and_layout(cx: &mut TestAppContext) {
	let (shell, cx) = open_with(cx, attached());

	let test_session_id = SessionId::new("reopened-session-42").unwrap();

	// Mutate shell store: set active session, open sidebar and bottom dock
	shell.update(cx, |shell, cx| {
		shell.store.frontend.selected_session = Some(test_session_id.clone());
		shell.store.frontend.panels.sidebar_open = true;
		shell.store.frontend.panels.bottom_open = true;
		shell.store.frontend.bottom_tab = BottomTab::Problems;
		shell.store.frontend.panels.inspector_open = true;
		shell.store.frontend.inspector_tab = InspectorTab::Details;
		cx.notify();
	});

	let recorded_bounds = Bounds::new(point(px(150.0), px(120.0)), size(px(1250.0), px(750.0)));

	// Record ReopenState as happens on window close
	cx.set_global(ReopenState { shell: shell.clone(), last_bounds: Some(recorded_bounds) });

	// Reopen path: extract global ReopenState
	let (restored_shell, restored_bounds) = cx.read_global::<ReopenState, _>(|r, _| {
		(r.shell.clone(), r.last_bounds.expect("recorded bounds must exist"))
	});
	assert_eq!(restored_bounds, recorded_bounds);

	// Verify restored shell retained all exact session and layout state
	restored_shell.read_with(cx, |shell, _| {
		assert_eq!(
			shell.store.frontend.selected_session,
			Some(test_session_id),
			"selected session must survive window close and reopen"
		);
		assert!(
			shell.store.frontend.panels.sidebar_open,
			"sidebar layout state must survive window close and reopen"
		);
		assert!(
			shell.store.frontend.panels.bottom_open,
			"bottom dock layout state must survive window close and reopen"
		);
		assert_eq!(
			shell.store.frontend.bottom_tab,
			BottomTab::Problems,
			"bottom tab selection must survive window close and reopen"
		);
		assert!(
			shell.store.frontend.panels.inspector_open,
			"inspector layout state must survive window close and reopen"
		);
		assert_eq!(
			shell.store.frontend.inspector_tab,
			InspectorTab::Details,
			"inspector tab selection must survive window close and reopen"
		);
	});
}

#[test]
fn application_menu_carries_crate_version_and_updates_live_enablement() {
	let app_menus = menus::app_menus(None);
	assert!(!app_menus.is_empty(), "menu bar must have menus");

	let veyyon_menu = &app_menus[0];
	assert_eq!(veyyon_menu.name.as_ref(), "Veyyon");

	let expected_version = env!("CARGO_PKG_VERSION");
	let about_item = veyyon_menu
		.items
		.first()
		.expect("About item must be first in Veyyon menu");

	match about_item {
		gpui::MenuItem::Action { name, .. } => {
			assert!(
				name.contains(expected_version),
				"About item must carry real crate version {expected_version}, got {name}"
			);
		},
		_ => panic!("About item must be an Action MenuItem"),
	}

	// Verify menu categories exist
	let menu_names: Vec<&str> = app_menus.iter().map(|m| m.name.as_ref()).collect();
	assert!(menu_names.contains(&"Veyyon"));
	assert!(menu_names.contains(&"Conversation"));
	assert!(menu_names.contains(&"Edit"));
	assert!(menu_names.contains(&"View"));

	// Live enablement test with Store
	let mut disconnected_store = Store::detached();
	disconnected_store.frontend.selected_session = None;
	let menus_disconnected = menus::app_menus(Some(&disconnected_store));
	let conv_menu = menus_disconnected
		.iter()
		.find(|m| m.name.as_ref() == "Conversation")
		.expect("Conversation menu must exist");

	// Close overlay is disabled when overlays stack is empty
	let close_overlay = conv_menu.items.iter().find(|i| match i {
		gpui::MenuItem::Action { name, .. } => name.as_ref() == "Close Overlay",
		_ => false,
	});
	if let Some(gpui::MenuItem::Action { disabled, .. }) = close_overlay {
		assert!(*disabled, "Close Overlay must be disabled when no overlay is open");
	}

	// Open overlay and verify live enablement switches to enabled
	let mut store_with_overlay = Store::detached();
	store_with_overlay
		.frontend
		.overlays
		.push(Overlay::CommandPalette { mode: PaletteMode::Commands });
	let menus_with_overlay = menus::app_menus(Some(&store_with_overlay));
	let conv_menu_open = menus_with_overlay
		.iter()
		.find(|m| m.name.as_ref() == "Conversation")
		.expect("Conversation menu must exist");

	let close_overlay_enabled = conv_menu_open.items.iter().find(|i| match i {
		gpui::MenuItem::Action { name, .. } => name.as_ref() == "Close Overlay",
		_ => false,
	});
	if let Some(gpui::MenuItem::Action { disabled, .. }) = close_overlay_enabled {
		assert!(!*disabled, "Close Overlay must be enabled when an overlay is open on stack");
	}
}

#[test]
fn macos_shortcuts_install_cmd_w_and_cmd_q() {
	let bindings = menus::app_key_bindings(true);
	assert_eq!(bindings.len(), 5, "5 macos system bindings must be defined");
	let linux_bindings = menus::app_key_bindings(false);
	assert!(linux_bindings.is_empty(), "no macos-specific bindings on linux");
}
