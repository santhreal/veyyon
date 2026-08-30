//! Which drawing stands for a command.
//!
//! Core names what a command is and what group it belongs to. It does not know
//! that a window has drawings in it, so the mapping lives here.
//!
//! MOST COMMANDS HAVE NO ICON, ON PURPOSE. A glyph earns its place by being
//! recognised faster than the words beside it: a trash can, a plus, a moon. A
//! list where every row carries a drawing is a column of noise that makes the
//! three that matter unfindable, which is what a stock icon set does to a
//! palette. So this returns `None` for anything without a drawing a reader
//! already knows, and a row with no icon simply has none.

use veyyon_gui_core::{
	command::{Command, Group},
	store::model::{Appearance, SettingsPage},
};
use veyyon_gui_kit::ui::Icon;

/// The drawing for a command, where one is clearer than its words.
pub fn of(command: &Command) -> Option<Icon> {
	match command {
		Command::NewSession => Some(Icon::New),
		Command::DeleteSession(_) | Command::DeleteSelected => Some(Icon::Delete),
		Command::ToggleSidebar => Some(Icon::Panel),
		Command::OpenPalette | Command::PaletteQuery(_) => Some(Icon::Search),
		Command::OpenSettings(SettingsPage::Appearance) => Some(Icon::Settings),
		Command::OpenSettings(SettingsPage::Keys) => Some(Icon::Keyboard),
		Command::Back | Command::CloseSettings => Some(Icon::Close),
		Command::SetAppearance(Appearance::Light) => Some(Icon::Light),
		Command::SetAppearance(Appearance::Dark) => Some(Icon::Dark),
		Command::StepTextSize { up: true } => Some(Icon::TextUp),
		Command::StepTextSize { up: false } => Some(Icon::TextDown),
		Command::Send => Some(Icon::Send),
		Command::ToggleProject(_) => Some(Icon::Checkout),
		// No drawing. A conversation is named by its title, a cycle is a
		// direction rather than a thing, a tool row already draws the kind of
		// thing the tool did, and there is no widely known glyph for grouping by
		// folder, flipping the appearance, or quitting.
		Command::SelectSession(_)
		| Command::CycleSession { .. }
		| Command::ToggleTool(_)
		| Command::ResetSidebarWidth
		| Command::SetSidebarWidth(_)
		| Command::MovePaletteCursor { .. }
		| Command::StepSettingsPage { .. }
		| Command::AcceptPalette
		| Command::FlipAppearance
		| Command::ToggleGroupByFolder
		| Command::FocusComposer
		| Command::Quit => None,
	}
}

/// The drawing for a whole group, for a heading over its rows.
pub fn group(group: Group) -> Icon {
	match group {
		Group::Conversation => Icon::Engine,
		Group::Window => Icon::Panel,
		Group::Appearance => Icon::Light,
		Group::Settings => Icon::Settings,
		Group::Danger => Icon::Failed,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. Two failures, both of which look like polish and
	//! read as sloppiness: one drawing standing for two different commands in
	//! one list, so a reader cannot tell them apart; and the drift where every
	//! new command quietly acquires a generic glyph until the palette is a wall
	//! of grey shapes. The mapping is exhaustive, so a new command fails to
	//! compile until somebody decides which of the two it is.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the drawing means what it is claimed to
	//! mean, which only a reader can say.

	use super::*;

	#[test]
	fn no_two_commands_in_one_list_share_a_drawing() {
		// The palette is the one place every searchable command appears
		// together, so it is where a collision is visible.
		//
		// Compared by document, not by variant: two variants over one file are
		// two names for one drawing, and a reader sees the drawing. `New` and
		// `More` were both `plus.svg`, and a palette listing "Start a
		// conversation" and "Larger text" drew the same mark against each.
		let mut seen: Vec<(&'static str, &'static str)> = Vec::new();
		for command in veyyon_gui_core::command::searchable() {
			let Some(icon) = of(&command) else { continue };
			if let Some((_, other)) = seen.iter().find(|(had, _)| *had == icon.file()) {
				panic!("{:?} stands for both {other:?} and {:?}", icon.file(), command.what());
			}
			seen.push((icon.file(), command.what()));
		}
	}

	#[test]
	fn the_commands_drawn_with_no_icon_are_a_recorded_decision() {
		// Pinned by equality: a command that gains or loses a drawing shows up
		// here. The list is the argument that a glyph has to earn its place.
		let bare: Vec<&'static str> = veyyon_gui_core::command::searchable()
			.iter()
			.filter(|command| of(command).is_none())
			.map(|command| command.what())
			.collect();
		assert_eq!(bare, vec![
			"Next conversation",
			"Previous conversation",
			"Group conversations by checkout",
			"Light or dark appearance",
			"Quit",
		]);
	}

	#[test]
	fn every_drawing_a_command_uses_is_one_the_window_ships() {
		// `Icon::bytes` is an `include_bytes!`, so a missing file is a compile
		// error; what this catches is an empty or truncated file, which draws as
		// nothing and looks like a layout defect.
		for command in veyyon_gui_core::command::searchable() {
			if let Some(icon) = of(&command) {
				assert!(icon.bytes().len() > 64, "{:?} is not a drawing", icon.file());
			}
		}
	}
}
