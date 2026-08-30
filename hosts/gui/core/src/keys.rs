//! Every key the window answers to, against the command it runs.
//!
//! One table. The keymap the app installs and the list the keyboard page shows
//! are built from these rows, so a key that works is a key that is documented
//! and a key that is documented is a key that works. There is no second table
//! to forget.
//!
//! `secondary-` is Command on macOS and Control everywhere else, which is why a
//! row is written in keystroke syntax and spelled for a reader at the point it
//! is drawn rather than the other way round.
//!
//! WHAT IS NOT HERE. The caret's own bindings. A field answers to Home, to
//! alt-left and to twenty other motions, and none of them is a feature: a
//! keyboard page listing thirty caret motions hides the ten that matter. Those
//! rows belong to the editor, in `veyyon-gui-kit`.

use crate::{command::Command, store::model::SettingsPage};

/// The dispatch context a row applies in.
///
/// A context is a claim about what holds the keyboard. `Everywhere` is for the
/// few chords that must work whatever is focused; every other row names the one
/// place it belongs, because a chord claimed in two contexts at once is a chord
/// where one of the two silently never fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Context {
	/// Anywhere in the window, whatever holds the keyboard.
	Everywhere,
	/// The window, when no field has claimed the keystroke first.
	Shell,
	/// The composer.
	Composer,
	/// The palette's field, where up, down and Return belong to the list under
	/// it rather than to the caret.
	Palette,
}

impl Context {
	/// The name the toolkit's own predicate parser knows this by.
	///
	/// A string, because the predicate language is a string; this is the one
	/// place the two vocabularies meet.
	pub fn predicate(self) -> Option<&'static str> {
		match self {
			Context::Everywhere => None,
			Context::Shell => Some("Shell"),
			Context::Composer => Some("MultilineEditor"),
			Context::Palette => Some("PaletteSearch"),
		}
	}
}

/// One binding: the chord, where it applies, and what it does.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
	pub keys:    &'static str,
	pub context: Context,
	pub command: Command,
	/// Whether the keyboard page lists it.
	///
	/// The rows it does not list are the ones whose absence would be a defect
	/// rather than whose presence is a feature: walking the palette's own list
	/// with the arrow keys is not a shortcut anybody looks up.
	pub listed:  bool,
}

/// Every binding the window installs.
pub fn table() -> Vec<Row> {
	vec![
		listed("secondary-k", Context::Shell, Command::OpenPalette),
		listed("secondary-n", Context::Shell, Command::NewSession),
		listed("secondary-b", Context::Shell, Command::ToggleSidebar),
		listed("secondary-,", Context::Shell, Command::OpenSettings(SettingsPage::Appearance)),
		// Shift is part of it deliberately. Deleting a conversation cannot be
		// undone, and `secondary-backspace` is one finger from the delete-word
		// chord a reader uses inside the composer that always holds the
		// keyboard.
		listed("secondary-shift-backspace", Context::Shell, Command::DeleteSelected),
		listed("ctrl-tab", Context::Shell, Command::CycleSession { forward: true }),
		listed("ctrl-shift-tab", Context::Shell, Command::CycleSession { forward: false }),
		listed("secondary-shift-l", Context::Shell, Command::FlipAppearance),
		listed("secondary-i", Context::Shell, Command::FocusComposer),
		listed("secondary-=", Context::Shell, Command::StepTextSize { up: true }),
		listed("secondary--", Context::Shell, Command::StepTextSize { up: false }),
		listed("secondary-q", Context::Everywhere, Command::Quit),
		listed("escape", Context::Shell, Command::Back),
		listed("enter", Context::Composer, Command::Send),
		// The palette's own list. Unlisted: an arrow key walking a list on
		// screen is not a shortcut.
		unlisted("up", Context::Palette, Command::MovePaletteCursor { down: false }),
		unlisted("down", Context::Palette, Command::MovePaletteCursor { down: true }),
		unlisted("enter", Context::Palette, Command::AcceptPalette),
		unlisted("escape", Context::Palette, Command::Back),
	]
}

fn listed(keys: &'static str, context: Context, command: Command) -> Row {
	Row { keys, context, command, listed: true }
}

fn unlisted(keys: &'static str, context: Context, command: Command) -> Row {
	Row { keys, context, command, listed: false }
}

/// The chord that runs a command, for a tooltip or a menu row that wants to
/// print it.
///
/// The first row that runs the command, because a command bound twice is bound
/// once for the reader: the second chord is a synonym nobody is shown.
pub fn chord_for(command: &Command) -> Option<&'static str> {
	table()
		.into_iter()
		.find(|row| &row.command == command)
		.map(|row| row.keys)
}

/// The rows the keyboard page lists, in the order it lists them.
pub fn listed_rows() -> Vec<Row> {
	table().into_iter().filter(|row| row.listed).collect()
}

#[cfg(test)]
mod tests;
