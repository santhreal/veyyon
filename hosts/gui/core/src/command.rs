//! Everything the window can be asked to do.
//!
//! One table. A press, a keystroke and a palette row all build the same
//! [`Command`] and hand it to [`Command::run`], which is the only way the store
//! changes. Three properties follow, and they are the whole reason for the
//! indirection:
//!
//! - Every action is reachable by pointer, by key and by search, by
//!   construction. A feature cannot ship keyboard-only by accident.
//! - A surface needs no handle on a view type to do anything. It builds a
//!   value.
//! - Behavior is tested without a window: `run` is a function over the store.
//!
//! WHAT A COMMAND IS NOT. It is not a message to a view, not a place to put
//! window code, and not a hook. It is a decision about state. The few effects
//! the store cannot perform on itself come back as an [`Outcome`], which the
//! shell carries out.

mod run;

use crate::store::model::{Appearance, ProjectId, SessionId, SettingsPage};

/// A thing the window can be asked to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
	/// Start a conversation in the selected checkout.
	NewSession,
	/// Show a conversation.
	SelectSession(SessionId),
	/// Delete a conversation. Not undoable, which is why the chord carries a
	/// shift and the palette row says so.
	DeleteSession(SessionId),
	/// Delete the one on screen. What a chord and a palette row mean, since
	/// neither carries an argument.
	DeleteSelected,
	/// Show the next or previous conversation in the drawn order.
	CycleSession { forward: bool },
	/// Fold or unfold a checkout's group.
	ToggleProject(ProjectId),

	/// Show or hide the conversation list.
	ToggleSidebar,
	/// Return the list to its opening width.
	ResetSidebarWidth,
	/// Set the list's width from a drag.
	SetSidebarWidth(f32),

	/// Open the command palette over whatever is on screen.
	OpenPalette,
	/// Back out of whatever is on top: the palette first, then a settings page.
	///
	/// One command rather than two, because it is one keystroke to a reader and
	/// two rows on Escape in one context is a row that never fires.
	Back,
	/// Walk the palette's list.
	MovePaletteCursor { down: bool },
	/// Take the highlighted palette row.
	AcceptPalette,
	/// Type into the palette.
	PaletteQuery(String),

	/// Open a settings page.
	OpenSettings(SettingsPage),
	/// Leave settings for the conversation.
	CloseSettings,

	/// Switch between light and dark.
	FlipAppearance,
	/// Set the appearance directly, which is what the appearance page's own
	/// control does.
	SetAppearance(Appearance),
	/// One step of text size.
	StepTextSize { up: bool },
	/// Group the conversation list by checkout, or run it flat.
	ToggleGroupByFolder,

	/// Send the draft.
	Send,
	/// Put the caret back in the composer.
	FocusComposer,
	/// Close the window.
	Quit,
}

/// Where the caret goes after a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
	/// The composer, which is where it lives unless something took it.
	Composer,
	/// The palette's field, for as long as the palette is open.
	Palette,
}

/// The effects a command needs that the store cannot perform on itself.
///
/// Not an enum: a send both empties the composer's own buffer and scrolls the
/// transcript, and an enum would force one of the two to be implicit. Every
/// field is a claim about the window, and a new one has to be argued for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Outcome {
	/// Where the caret belongs now.
	pub focus:            Option<Focus>,
	/// The store's draft for the conversation on screen is no longer what the
	/// field holds. The field's own buffer is a copy, and this says to take the
	/// store's again: after a send it is empty, and after switching
	/// conversations it is the other conversation's unsent text.
	pub draft_changed:    bool,
	/// Put the transcript at the latest message.
	pub scroll_to_latest: bool,
	/// Close the window.
	pub quit:             bool,
}

impl Outcome {
	/// Nothing outside the store has to happen.
	pub fn nothing() -> Outcome {
		Outcome::default()
	}

	pub fn focus(focus: Focus) -> Outcome {
		Outcome { focus: Some(focus), ..Outcome::default() }
	}
}

/// What a command is about, for grouping in the palette and for choosing the
/// glyph a row is drawn with.
///
/// Core names the group; which drawing stands for it is a question for the
/// crate that owns drawings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
	/// Conversations: starting, showing, deleting.
	Conversation,
	/// The window's own shape: the list, the palette, the caret.
	Window,
	/// How the window reads: appearance, text size, grouping.
	Appearance,
	/// Settings, and leaving them.
	Settings,
	/// Something that cannot be undone.
	Danger,
}

impl Command {
	/// What this does, in the words every surface uses for it: the palette row,
	/// the tooltip, the menu item and the keyboard page are all this string.
	pub fn what(&self) -> &'static str {
		match self {
			Command::NewSession => "Start a conversation",
			Command::SelectSession(_) => "Show this conversation",
			Command::DeleteSession(_) | Command::DeleteSelected => "Delete this conversation",
			Command::CycleSession { forward: true } => "Next conversation",
			Command::CycleSession { forward: false } => "Previous conversation",
			Command::ToggleProject(_) => "Fold or unfold this checkout",
			Command::ToggleSidebar => "Show or hide the conversation list",
			Command::ResetSidebarWidth => "Return the list to its opening width",
			Command::SetSidebarWidth(_) => "Set the list's width",
			Command::OpenPalette => "Search conversations and run a command",
			Command::Back => "Close what is open",
			Command::MovePaletteCursor { down: true } => "Next match",
			Command::MovePaletteCursor { down: false } => "Previous match",
			Command::AcceptPalette => "Take the highlighted match",
			Command::PaletteQuery(_) => "Search",
			Command::OpenSettings(SettingsPage::Appearance) => "Settings",
			Command::OpenSettings(SettingsPage::Keys) => "Keyboard shortcuts",
			Command::CloseSettings => "Leave settings",
			Command::FlipAppearance => "Light or dark appearance",
			Command::SetAppearance(Appearance::Dark) => "Dark appearance",
			Command::SetAppearance(Appearance::Light) => "Light appearance",
			Command::StepTextSize { up: true } => "Larger text",
			Command::StepTextSize { up: false } => "Smaller text",
			Command::ToggleGroupByFolder => "Group conversations by checkout",
			Command::Send => "Send",
			Command::FocusComposer => "Put the caret back in the composer",
			Command::Quit => "Quit",
		}
	}

	/// Words a reader might type that are not in the title.
	///
	/// The palette matches the title first; this is for the case where the word
	/// somebody reaches for is not the word the window uses. It is not a place
	/// to list synonyms nobody types.
	pub fn keywords(&self) -> &'static str {
		match self {
			Command::NewSession => "new chat thread",
			Command::ToggleSidebar => "panel list hide",
			Command::OpenPalette => "command find search",
			Command::OpenSettings(SettingsPage::Appearance) => "preferences options configure",
			Command::OpenSettings(SettingsPage::Keys) => "keys chords bindings",
			Command::FlipAppearance | Command::SetAppearance(_) => "theme dark light mode",
			Command::StepTextSize { .. } => "font size zoom",
			Command::ToggleGroupByFolder => "project folder checkout",
			Command::DeleteSession(_) | Command::DeleteSelected => "remove close",
			Command::Quit => "exit close window",
			_ => "",
		}
	}

	pub fn group(&self) -> Group {
		match self {
			Command::NewSession
			| Command::SelectSession(_)
			| Command::CycleSession { .. }
			| Command::ToggleProject(_)
			| Command::Send => Group::Conversation,
			Command::ToggleSidebar
			| Command::ResetSidebarWidth
			| Command::SetSidebarWidth(_)
			| Command::OpenPalette
			| Command::Back
			| Command::MovePaletteCursor { .. }
			| Command::AcceptPalette
			| Command::PaletteQuery(_)
			| Command::FocusComposer => Group::Window,
			Command::FlipAppearance
			| Command::SetAppearance(_)
			| Command::StepTextSize { .. }
			| Command::ToggleGroupByFolder => Group::Appearance,
			Command::OpenSettings(_) | Command::CloseSettings => Group::Settings,
			Command::DeleteSession(_) | Command::DeleteSelected | Command::Quit => Group::Danger,
		}
	}
}

/// Every command a reader can find by searching, in the order the palette lists
/// them.
///
/// The ones with an argument are absent on purpose: a palette row for
/// `SelectSession` is a conversation, and the palette lists those from the
/// store rather than from here.
pub fn searchable() -> Vec<Command> {
	vec![
		Command::NewSession,
		Command::DeleteSelected,
		Command::CycleSession { forward: true },
		Command::CycleSession { forward: false },
		Command::ToggleSidebar,
		Command::ToggleGroupByFolder,
		Command::OpenSettings(SettingsPage::Appearance),
		Command::OpenSettings(SettingsPage::Keys),
		Command::FlipAppearance,
		Command::StepTextSize { up: true },
		Command::StepTextSize { up: false },
		Command::Quit,
	]
}

#[cfg(test)]
mod tests;
