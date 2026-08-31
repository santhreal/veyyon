//! Application menu tree structure, command mapping, and enablement predicates.
//!
//! WHY IN CORE:
//! The menu bar is an alternative presentation of the command registry, sharing
//! the same verbs, chords, and enablement predicates as the command palette.
//! Placing the semantic menu structure in core keeps it independent of the GUI
//! toolkit and testable without a display server or window manager, while
//! ensuring that menu enablement and palette enablement share identical
//! predicate functions against the store.

mod opt_outs;
mod opt_outs_editor;
mod opt_outs_host;
mod opt_outs_navigation;
mod variants_all;
mod variants_name;

pub use opt_outs::opt_outs;
pub use variants_all::all_command_variants;
pub use variants_name::command_variant_name;

use crate::{
	Store, UiCommand,
	navigation::{BottomTab, InspectorTab, Overlay, PaletteMode, Route, SettingsPage},
};

/// A single entry in a menu: either an action bound to a command with an
/// enablement predicate, or a visual separator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
	Action { title: &'static str, command: UiCommand },
	Separator,
}

/// A named menu in the application menu bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuDef {
	pub title:   &'static str,
	pub entries: Vec<MenuEntry>,
}

/// An opt-out declaration explaining why a command is excluded from the menu
/// bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptOut {
	pub command_name: &'static str,
	pub reason:       &'static str,
}

/// The semantic application menu tree.
pub fn menu_tree() -> Vec<MenuDef> {
	vec![
		MenuDef {
			title:   "Veyyon",
			entries: vec![
				MenuEntry::Action {
					title:   "Settings",
					command: UiCommand::Navigate(Route::Settings(SettingsPage::General)),
				},
				MenuEntry::Action {
					title:   "Appearance",
					command: UiCommand::Navigate(Route::Settings(SettingsPage::Appearance)),
				},
				MenuEntry::Action {
					title:   "Keyboard Shortcuts",
					command: UiCommand::Navigate(Route::Settings(SettingsPage::Keybindings)),
				},
				MenuEntry::Separator,
				MenuEntry::Action { title: "Quit Veyyon", command: UiCommand::QuitWindow },
			],
		},
		MenuDef {
			title:   "Conversation",
			entries: vec![
				MenuEntry::Action {
					title:   "New Session",
					command: UiCommand::CreateSession { workspace: None, parent: None },
				},
				MenuEntry::Action {
					title:   "Next Session",
					command: UiCommand::CycleSession { forward: true },
				},
				MenuEntry::Action {
					title:   "Previous Session",
					command: UiCommand::CycleSession { forward: false },
				},
				MenuEntry::Action {
					title:   "Switch Session...",
					command: UiCommand::OpenOverlay(Overlay::SessionSwitcher),
				},
				MenuEntry::Separator,
				MenuEntry::Action { title: "Close Overlay", command: UiCommand::CloseTopOverlay },
				MenuEntry::Action {
					title:   "Close All Overlays",
					command: UiCommand::CloseAllOverlays,
				},
			],
		},
		MenuDef {
			title:   "Edit",
			entries: vec![MenuEntry::Action {
				title:   "Copy Output",
				command: UiCommand::CopyOutput,
			}],
		},
		MenuDef {
			title:   "View",
			entries: vec![
				MenuEntry::Action {
					title:   "Command Palette...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Commands,
					}),
				},
				MenuEntry::Action {
					title:   "Quick Open...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::QuickOpen,
					}),
				},
				MenuEntry::Action {
					title:   "Search Sessions...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Sessions,
					}),
				},
				MenuEntry::Action {
					title:   "Search Messages...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Messages,
					}),
				},
				MenuEntry::Action {
					title:   "Search Files...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Files,
					}),
				},
				MenuEntry::Action {
					title:   "Choose Model...",
					command: UiCommand::OpenOverlay(Overlay::ModelPicker),
				},
				MenuEntry::Action {
					title:   "Search Providers...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Providers,
					}),
				},
				MenuEntry::Action {
					title:   "Search Settings...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Settings,
					}),
				},
				MenuEntry::Action {
					title:   "Search Agents...",
					command: UiCommand::OpenOverlay(Overlay::CommandPalette {
						mode: PaletteMode::Agents,
					}),
				},
				MenuEntry::Separator,
				MenuEntry::Action {
					title:   "Conversation",
					command: UiCommand::Navigate(Route::Conversation),
				},
				MenuEntry::Action { title: "Changes", command: UiCommand::Navigate(Route::Changes) },
				MenuEntry::Action { title: "Files", command: UiCommand::Navigate(Route::Files) },
				MenuEntry::Action { title: "Agents", command: UiCommand::Navigate(Route::Agents) },
				MenuEntry::Separator,
				MenuEntry::Action { title: "Toggle Sidebar", command: UiCommand::ToggleSidebar },
				MenuEntry::Action { title: "Toggle Inspector", command: UiCommand::ToggleInspector },
				MenuEntry::Action {
					title:   "Toggle Bottom Dock",
					command: UiCommand::ToggleBottomDock,
				},
				MenuEntry::Separator,
				MenuEntry::Action {
					title:   "Show Terminals",
					command: UiCommand::SetBottomTab(BottomTab::Terminals),
				},
				MenuEntry::Action {
					title:   "Show Problems",
					command: UiCommand::SetBottomTab(BottomTab::Problems),
				},
				MenuEntry::Action {
					title:   "Show Output",
					command: UiCommand::SetBottomTab(BottomTab::Output),
				},
				MenuEntry::Separator,
				MenuEntry::Action {
					title:   "Show Context",
					command: UiCommand::SetInspectorTab(InspectorTab::Context),
				},
				MenuEntry::Action {
					title:   "Show Details",
					command: UiCommand::SetInspectorTab(InspectorTab::Details),
				},
				MenuEntry::Action {
					title:   "Show Outline",
					command: UiCommand::SetInspectorTab(InspectorTab::Outline),
				},
				MenuEntry::Separator,
				MenuEntry::Action {
					title:   "Dark Appearance",
					command: UiCommand::SetDarkAppearance(true),
				},
				MenuEntry::Action {
					title:   "Light Appearance",
					command: UiCommand::SetDarkAppearance(false),
				},
				MenuEntry::Action {
					title:   "Toggle Reduced Motion",
					command: UiCommand::SetReducedMotion(true),
				},
				MenuEntry::Separator,
				MenuEntry::Action {
					title:   "Jump to Oldest Message",
					command: UiCommand::JumpToOldest,
				},
				MenuEntry::Action {
					title:   "Jump to Latest Message",
					command: UiCommand::JumpToLatest,
				},
				MenuEntry::Separator,
				MenuEntry::Action { title: "Focus Composer", command: UiCommand::FocusComposer },
				MenuEntry::Action { title: "Focus Palette", command: UiCommand::FocusPalette },
			],
		},
	]
}

/// Evaluate live enablement of a command against current store state.
///
/// Returns true if the command is currently actionable, by the same refusals
/// the palette draws and the dispatcher applies: a host verb needs a
/// connection, and the verbs that address a selection need one.
pub fn is_command_enabled(command: &UiCommand, store: &Store) -> bool {
	// Where `Store::emit_checked` stops a host action in a window that reached
	// no engine. A menu bar is a snapshot the platform never re-reads, so an
	// item reporting itself reachable in a detached window stays wrong for as
	// long as that snapshot is installed.
	if command.class() == crate::command::CommandClass::Host && !store.connection.is_connected() {
		return false;
	}
	match command {
		UiCommand::OpenOverlay(Overlay::RenameSession { .. })
		| UiCommand::OpenOverlay(Overlay::Confirmation { .. })
		| UiCommand::RenameSession { .. }
		| UiCommand::DeleteSession(_) => {
			store.frontend.selected_session.is_some() && store.connection.is_connected()
		},
		UiCommand::CloseTopOverlay | UiCommand::CloseAllOverlays => {
			!store.frontend.overlays.is_empty()
		},
		UiCommand::OpenOverlay(Overlay::PlanReview { .. }) => {
			store.replica.plan.readable().is_some_and(|p| {
				matches!(&p.value, crate::model::PlanState::Active { approval: Some(_), .. })
			})
		},
		_ => true,
	}
}

impl MenuEntry {
	pub fn is_enabled(&self, store: &Store) -> bool {
		match self {
			Self::Action { command, .. } => is_command_enabled(command, store),
			Self::Separator => false,
		}
	}
}
