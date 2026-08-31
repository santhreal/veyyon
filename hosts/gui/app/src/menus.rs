//! Native application menu bar and app-level window lifecycle actions.
//!
//! The menu bar is derived from the core command menu tree and platform
//! actions. Keyboard accelerators are sourced from `veyyon_gui_core::keys` via
//! `Do(command)`. Live enablement evaluates the exact same refusal predicates
//! used by the command palette.

use std::hash::{DefaultHasher, Hash, Hasher};

use gpui::{App, KeyBinding, Menu, MenuItem, SystemMenuType, Window, actions};
use veyyon_gui_core::{
	Store, UiCommand,
	command::menu::{MenuEntry, is_command_enabled, menu_tree},
	navigation::{Route, SettingsPage},
};
use veyyon_gui_features::act::Do;

actions!(veyyon, [About, QuitApp, HideApp, HideOthers, ShowAll, Minimize, Zoom, CloseWindow,]);

/// Register global actions backing the application menu bar and shortcuts.
pub fn init(cx: &mut App) {
	cx.on_action(|_: &About, _| {});
	cx.on_action(|_: &QuitApp, cx: &mut App| cx.quit());
	cx.on_action(|_: &HideApp, cx: &mut App| cx.hide());
	cx.on_action(|_: &HideOthers, cx: &mut App| cx.hide_other_apps());
	cx.on_action(|_: &ShowAll, cx: &mut App| cx.unhide_other_apps());
	cx.on_action(|_: &Minimize, cx: &mut App| {
		with_active_window(cx, |window| window.minimize_window());
	});
	cx.on_action(|_: &Zoom, cx: &mut App| {
		with_active_window(cx, |window| window.zoom_window());
	});
	cx.on_action(|_: &CloseWindow, cx: &mut App| {
		with_active_window(cx, |window| window.remove_window());
	});
}

/// Execute an operation on the currently active window if one is open.
pub fn with_active_window(cx: &mut App, f: impl FnOnce(&mut Window)) {
	if let Some(window) = cx.active_window() {
		window.update(cx, |_, window, _| f(window)).ok();
	}
}

/// Install application-level shortcuts for window management and platform
/// verbs.
pub fn bind_keys(cx: &mut App) {
	cx.bind_keys(app_key_bindings(cfg!(target_os = "macos")));
}

/// Application-level keyboard bindings table.
pub fn app_key_bindings(macos: bool) -> Vec<KeyBinding> {
	let mut bindings = Vec::new();
	if macos {
		bindings.extend([
			KeyBinding::new("cmd-q", QuitApp, None),
			KeyBinding::new("cmd-h", HideApp, None),
			KeyBinding::new("alt-cmd-h", HideOthers, None),
			KeyBinding::new("cmd-m", Minimize, None),
			KeyBinding::new("cmd-w", CloseWindow, None),
		]);
	}
	bindings
}

/// What the menu bar reports as reachable, and when that answer went stale.
///
/// The native menu bar is a snapshot: `set_menus` hands the platform a tree
/// with each item's enabled state baked in, and the platform never asks again.
/// A window that installs it once at open draws a menu describing the store as
/// it was before the first session arrived, so the item a reader reaches for
/// stays greyed out for the rest of the process.
///
/// Rebuilding the tree on every settle would allocate one per keystroke, so the
/// commands the menus name are collected once and only their enablement is
/// re-read: a fingerprint over that answer, no allocation per check, and the
/// tree is rebuilt on the settle where an answer moved.
pub struct MenuEnablement {
	commands:    Vec<UiCommand>,
	fingerprint: u64,
}

impl MenuEnablement {
	/// The commands the menu bar names, in menu order, with nothing installed
	/// yet, so the first check against any store reports stale.
	pub fn of_the_menu_tree() -> Self {
		let mut commands = Vec::new();
		for menu_def in menu_tree() {
			for entry in menu_def.entries {
				if let MenuEntry::Action { command, .. } = entry {
					commands.push(command);
				}
			}
		}
		Self { commands, fingerprint: u64::MAX }
	}

	/// How many commands the menu bar's enablement is read from.
	pub fn len(&self) -> usize {
		self.commands.len()
	}

	/// Whether the menu bar contains zero actionable commands.
	pub fn is_empty(&self) -> bool {
		self.commands.is_empty()
	}

	/// Whether the installed menu bar still describes this store, recording the
	/// answer the rebuild is about to install.
	pub fn went_stale(&mut self, store: &Store) -> bool {
		let mut hasher = DefaultHasher::new();
		for command in &self.commands {
			is_command_enabled(command, store).hash(&mut hasher);
		}
		let fingerprint = hasher.finish();
		let stale = fingerprint != self.fingerprint;
		self.fingerprint = fingerprint;
		stale
	}
}

/// Build the native menu bar reflecting current store state and crate version
/// metadata.
pub fn app_menus(store: Option<&Store>) -> Vec<Menu> {
	let macos = cfg!(target_os = "macos");
	let version = env!("CARGO_PKG_VERSION");
	let about_title = format!("About Veyyon (v{version})");

	let mut app_items = vec![
		MenuItem::action(about_title, About).disabled(true),
		MenuItem::separator(),
		MenuItem::action("Settings", Do(UiCommand::Navigate(Route::Settings(SettingsPage::General)))),
		MenuItem::action(
			"Appearance",
			Do(UiCommand::Navigate(Route::Settings(SettingsPage::Appearance))),
		),
		MenuItem::action(
			"Keyboard Shortcuts",
			Do(UiCommand::Navigate(Route::Settings(SettingsPage::Keybindings))),
		),
		MenuItem::separator(),
	];

	if macos {
		app_items.extend([
			MenuItem::os_submenu("Services", SystemMenuType::Services),
			MenuItem::separator(),
			MenuItem::action("Hide Veyyon", HideApp),
			MenuItem::action("Hide Others", HideOthers),
			MenuItem::action("Show All", ShowAll),
			MenuItem::separator(),
		]);
	}

	app_items.push(MenuItem::action("Quit Veyyon", QuitApp));

	let mut menus = vec![Menu::new("Veyyon").items(app_items)];

	// Project dynamic semantic menus from core menu tree
	for menu_def in menu_tree() {
		if menu_def.title == "Veyyon" {
			continue;
		}

		let mut items = Vec::new();

		// The platform's Cut, Paste and Select All have no verb behind them in
		// this window: a transcript is not editable, and pasting belongs to
		// whichever field holds the keyboard, which already handles it. They
		// were each dispatching Copy Output, so Paste copied. Until a verb
		// routes to the focused surface, the Edit menu offers only what core
		// declares for it.

		for entry in menu_def.entries {
			match entry {
				MenuEntry::Action { title, command } => {
					let disabled = store.is_some_and(|state| !is_command_enabled(&command, state));
					items.push(MenuItem::action(title, Do(command)).disabled(disabled));
				},
				MenuEntry::Separator => {
					items.push(MenuItem::separator());
				},
			}
		}

		menus.push(Menu::new(menu_def.title).items(items));
	}

	if macos {
		menus.push(Menu::new("Window").items([
			MenuItem::action("Minimize", Minimize),
			MenuItem::action("Zoom", Zoom),
			MenuItem::separator(),
			MenuItem::action("Close Window", CloseWindow),
		]));
	}

	menus
}
