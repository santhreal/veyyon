//! Central keyboard bindings over [`UiCommand`](crate::UiCommand).
//!
//! The installed keymap and keybinding settings read the same rows. Editor and
//! IME navigation remain in the kit editor and are not duplicated here.

use crate::{
	UiCommand,
	navigation::{BottomTab, PaletteMode, Route, SettingsPage},
};

/// Where a row applies.
///
/// A context is a claim about what holds the keyboard. `Everywhere` is for the
/// chords that must fire whatever is focused; every other variant names one
/// place, because a chord claimed in two contexts that can both match is a
/// chord where one of the two never fires.
///
/// A field's own context wins over the window's for the same chord: bindings
/// are collected from the focused element outwards, so the caret keeps `up` in
/// the composer while the window keeps it on a route that draws no field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Context {
	Everywhere,
	Palette,
	Composer,
	Files,
	Settings,
}

impl Context {
	/// The name the toolkit's predicate parser knows this by, and `None` for a
	/// row that applies with nothing named.
	///
	/// The one place the two vocabularies meet. Every name here is declared by
	/// an element that can hold the keyboard or sit above whatever does: the
	/// two field names by the editor, the two route names by the window frame.
	/// A name nothing declares is a row that never fires.
	pub fn predicate(self) -> Option<&'static str> {
		match self {
			Self::Everywhere => None,
			Self::Palette => Some("PaletteSearch"),
			Self::Composer => Some("MultilineEditor"),
			Self::Files => Some("Files"),
			Self::Settings => Some("Settings"),
		}
	}
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
	pub keys:    &'static str,
	pub context: Context,
	pub command: UiCommand,
	pub listed:  bool,
}

pub fn table() -> Vec<Row> {
	vec![
		listed(
			"secondary-p",
			Context::Everywhere,
			UiCommand::OpenOverlay(crate::navigation::Overlay::CommandPalette {
				mode: PaletteMode::Commands,
			}),
		),
		listed(
			"secondary-shift-p",
			Context::Everywhere,
			UiCommand::OpenOverlay(crate::navigation::Overlay::CommandPalette {
				mode: PaletteMode::QuickOpen,
			}),
		),
		listed("escape", Context::Everywhere, UiCommand::CloseTopOverlay),
		listed("secondary-1", Context::Everywhere, UiCommand::Navigate(Route::Conversation)),
		listed("secondary-2", Context::Everywhere, UiCommand::Navigate(Route::Changes)),
		listed("secondary-3", Context::Everywhere, UiCommand::Navigate(Route::Files)),
		listed("secondary-4", Context::Everywhere, UiCommand::Navigate(Route::Agents)),
		listed("secondary-5", Context::Everywhere, UiCommand::Navigate(Route::History)),
		// Written as the keystroke the platform produces. `secondary-comma`
		// parses, and then matches nothing: a keystroke carries the character,
		// so the row has to spell it.
		listed(
			"secondary-,",
			Context::Everywhere,
			UiCommand::Navigate(Route::Settings(SettingsPage::General)),
		),
		listed("secondary-b", Context::Everywhere, UiCommand::ToggleSidebar),
		listed("secondary-shift-i", Context::Everywhere, UiCommand::ToggleInspector),
		listed("secondary-shift-b", Context::Everywhere, UiCommand::ToggleBottomDock),
		// The dock's tabs, on the chords an editor uses for the same three
		// panels, so a reader who knows one knows these.
		listed("secondary-j", Context::Everywhere, UiCommand::SetBottomTab(BottomTab::Terminals)),
		listed(
			"secondary-shift-m",
			Context::Everywhere,
			UiCommand::SetBottomTab(BottomTab::Problems),
		),
		listed("secondary-shift-u", Context::Everywhere, UiCommand::SetBottomTab(BottomTab::Output)),
		// Starting a conversation, and moving between the ones already open.
		// Without these three a reader reaches the daily verbs of the product
		// with the pointer only.
		listed("secondary-n", Context::Everywhere, UiCommand::CreateSession {
			workspace: None,
			parent:    None,
		}),
		listed("secondary-tab", Context::Everywhere, UiCommand::CycleSession { forward: true }),
		listed("secondary-shift-tab", Context::Everywhere, UiCommand::CycleSession {
			forward: false,
		}),
		listed(
			"secondary-shift-s",
			Context::Everywhere,
			UiCommand::OpenOverlay(crate::navigation::Overlay::SessionSwitcher),
		),
		// The model in use is changed as often as a conversation is started.
		listed(
			"secondary-m",
			Context::Everywhere,
			UiCommand::OpenOverlay(crate::navigation::Overlay::ModelPicker),
		),
		listed("secondary-enter", Context::Composer, UiCommand::FocusComposer),
		// The transcript's ends, on the document chords. The bare Home and End
		// belong to the field the caret is in, which is why these carry the
		// modifier: a reader in the composer reaches both without leaving it.
		listed("secondary-home", Context::Everywhere, UiCommand::JumpToOldest),
		listed("secondary-end", Context::Everywhere, UiCommand::JumpToLatest),
		// The settings pages, walked from the keyboard. Listed, because a reader
		// on that page has no other way to learn the arrows do anything there.
		listed("down", Context::Settings, UiCommand::StepSettingsPage { down: true }),
		listed("up", Context::Settings, UiCommand::StepSettingsPage { down: false }),
		listed("up", Context::Files, UiCommand::MoveFileCursor { forward: false }),
		listed("down", Context::Files, UiCommand::MoveFileCursor { forward: true }),
		listed("left", Context::Files, UiCommand::ToggleFileCursor),
		listed("right", Context::Files, UiCommand::ToggleFileCursor),
		listed("enter", Context::Files, UiCommand::OpenFileCursor),
		listed("secondary-shift-r", Context::Files, UiCommand::RevealSelectedFile),
		// The palette's own list. Unlisted: an arrow key walking a list that is
		// on screen with the highlight following it is not a shortcut anybody
		// looks up. The caret leaves these alone in that field, which is what
		// makes the rows reachable.
		unlisted("up", Context::Palette, UiCommand::MovePaletteCursor { down: false }),
		unlisted("down", Context::Palette, UiCommand::MovePaletteCursor { down: true }),
	]
}

fn listed(keys: &'static str, context: Context, command: UiCommand) -> Row {
	Row { keys, context, command, listed: true }
}

fn unlisted(keys: &'static str, context: Context, command: UiCommand) -> Row {
	Row { keys, context, command, listed: false }
}

pub fn chord_for(command: &UiCommand) -> Option<&'static str> {
	table()
		.into_iter()
		.find_map(|row| (row.command == *command).then_some(row.keys))
}

pub fn listed_rows() -> Vec<Row> {
	table().into_iter().filter(|row| row.listed).collect()
}
