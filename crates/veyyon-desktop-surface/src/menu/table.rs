//! Which verb sits in which menu, and which verb sits in none.
//!
//! The table is read at run time rather than written into the bar's renderer,
//! so `every-verb-the-window-has-is-reachable-without-a-chord` can sweep it
//! against `Command::iter()` and go red when a command arrives with nowhere to
//! be reached from.

use strum::EnumIter;

use crate::keymap::Command;

/// The menus the bar draws, in the order it draws them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter)]
pub enum MenuSectionId {
	Veyyon,
	Session,
	View,
	Edit,
	Turn,
}

impl MenuSectionId {
	/// The word the bar draws for this menu.
	#[must_use]
	pub const fn title(self) -> &'static str {
		match self {
			Self::Veyyon => "Veyyon",
			Self::Session => "Session",
			Self::View => "View",
			Self::Edit => "Edit",
			Self::Turn => "Turn",
		}
	}

	/// The verbs this menu holds, in the order they are drawn.
	#[must_use]
	pub const fn entries(self) -> &'static [Command] {
		match self {
			Self::Veyyon => {
				&[Command::OpenPalette, Command::OpenSettings, Command::CloseWindow, Command::Quit]
			},
			Self::Session => &[
				Command::NewSession,
				Command::OpenSelectedSession,
				Command::PreviousSession,
				Command::NextSession,
				Command::TogglePinSelected,
				Command::ToggleDeferSelected,
				Command::ToggleParkSelected,
				Command::FilterQueue,
				Command::CloseTabOrPark,
			],
			Self::View => &[
				Command::ToggleQueue,
				Command::TogglePanel,
				Command::ToggleDrawer,
				Command::PreviousTab,
				Command::NextTab,
				Command::ToggleDiffMode,
				Command::FindInTranscript,
				Command::PreviousTurn,
				Command::NextTurn,
				Command::ToggleBlock,
			],
			Self::Edit => &[Command::CopySelection, Command::SelectEntryText, Command::AttachFile],
			Self::Turn => &[
				Command::AbortTurn,
				Command::ToggleQueueMode,
				Command::TakeBackQueuedPrompt,
				Command::ModelPicker,
				Command::ThinkingLevel,
			],
		}
	}
}

/// The verbs no menu holds, and why each one is not a menu item.
///
/// A menu item is pressed once and does one thing. A verb that reads an
/// argument off the chord that invoked it -- which session, which option, how
/// far to scroll -- has no single thing to do; a verb that is one half of what
/// a key already means in the surface it is pressed in has nothing to name;
/// and the verb that opens the bar has nothing left to do from inside it. All
/// three stay out, by exact equality: adding a command puts it in a menu or on
/// this list, and nothing else compiles.
pub const MENU_OPT_OUT: [Command; 9] = [
	// Each carries an index or a distance from its binding.
	Command::FocusLive,
	Command::MoveSelection,
	Command::Scroll,
	Command::SelectOption,
	// Each is what a key already means where it is pressed: the composer's
	// Return and Shift+Return, the split control's other half, and Escape.
	Command::Primary,
	Command::Newline,
	Command::SplitHalf,
	Command::Dismiss,
	// The way into the bar, which has nothing to do once the bar is open.
	Command::OpenMenu,
];

/// Whether this verb is reached from a menu rather than from a chord alone.
#[must_use]
pub fn is_in_a_menu(command: Command) -> bool {
	use strum::IntoEnumIterator;

	MenuSectionId::iter().any(|section| section.entries().contains(&command))
}
