//! The menu bar's state: which section is open, which entry the keyboard is
//! on, and which verbs the host declined.
//!
//! Linux gpui stores the menus a process sets and draws none of them, so the
//! bar is drawn in the window. The state stays here rather than in the
//! renderer because the keyboard walks it and the tests drive it.

mod table;

pub use self::table::{MENU_OPT_OUT, MenuSectionId, is_in_a_menu};
use crate::keymap::Command;

/// Which section the bar has open, where the keyboard is inside it, and the
/// verbs the host cannot currently take.
///
/// `declined` holds commands, not capabilities, because the drawer's verb is
/// offered by either of two capabilities and the projection that fills this
/// resolves that once. An entry in `declined` is drawn refused and answers no
/// click, which is the same predicate the palette drops a row on.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MenuState {
	/// The open section, or none while the bar is closed.
	pub open:        Option<MenuSectionId>,
	/// The entry the keyboard is on inside the open section.
	pub highlighted: usize,
	/// The verbs the host declined, drawn refused and inert.
	pub declined:    Vec<Command>,
}

impl MenuState {
	/// Whether this verb can be taken right now.
	#[must_use]
	pub fn enabled(&self, command: Command) -> bool {
		!self.declined.contains(&command)
	}

	/// Opens `section` with the keyboard on its first offered entry.
	pub fn open_section(&mut self, section: MenuSectionId) {
		self.open = Some(section);
		self.highlighted = self.first_offered(section).unwrap_or(0);
	}

	/// Opens `section`, or closes the bar when that section is already open.
	pub fn toggle_section(&mut self, section: MenuSectionId) {
		if self.open == Some(section) {
			self.close();
		} else {
			self.open_section(section);
		}
	}

	/// Closes the bar.
	pub const fn close(&mut self) {
		self.open = None;
		self.highlighted = 0;
	}

	/// The verb the keyboard stands on, refused or not.
	///
	/// The walk skips a refused entry and an opening menu never stands on
	/// one, so this reports what it finds rather than filtering it a second
	/// time: the projection can withdraw the verb under the keyboard
	/// between frames, and refusing it there is the run gate's, which is
	/// the one place a refusal is enforced.
	#[must_use]
	pub fn highlighted_command(&self) -> Option<Command> {
		let entries = self.open?.entries();
		entries.get(self.highlighted).copied()
	}

	/// Moves the keyboard by `delta` entries, skipping the refused ones and
	/// wrapping at both ends.
	///
	/// A refused entry is never landed on, so Return always has something to
	/// take; a section whose every entry is refused leaves the keyboard where
	/// it was rather than looping.
	pub fn move_highlight(&mut self, delta: i32) {
		let Some(section) = self.open else { return };
		let entries = section.entries();
		if entries.is_empty() || delta == 0 {
			return;
		}
		let len = entries.len();
		let step = if delta > 0 { 1 } else { len - 1 };
		let mut at = self.highlighted.min(len - 1);
		for _ in 0..len {
			at = (at + step) % len;
			if self.enabled(entries[at]) {
				self.highlighted = at;
				return;
			}
		}
	}

	/// Moves to the section `delta` places along the bar, keeping it open.
	pub fn move_section(&mut self, delta: i32) {
		use strum::IntoEnumIterator;

		let Some(open) = self.open else { return };
		let sections: Vec<MenuSectionId> = MenuSectionId::iter().collect();
		let Some(at) = sections.iter().position(|section| *section == open) else {
			return;
		};
		let len = sections.len();
		let step = if delta > 0 { 1 } else { len - 1 };
		self.open_section(sections[(at + step) % len]);
	}

	/// The first entry of `section` that can be taken.
	fn first_offered(&self, section: MenuSectionId) -> Option<usize> {
		section
			.entries()
			.iter()
			.position(|command| self.enabled(*command))
	}
}
