//! Which of the bar's verbs the host declines, and where the keyboard may
//! stand inside the open menu.
//!
//! §5.13 states a verb the host declines is not offered. The palette drops
//! such a row and the bar draws its entry refused, which are two presentations
//! of one fact: this module is that fact, so the two cannot drift.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{Capability, CapabilityStatus, Store};
use veyyon_desktop_surface::{Command, MenuSectionId, MenuState};

use super::drawer::drawer_offered;

/// Whether the host cannot carry `command` right now.
///
/// The capability a verb rides on is `Command::capability` and nothing else.
/// The drawer is the one verb two capabilities offer -- a terminal or a
/// supervised process -- so either one is enough, which is the same rule the
/// drawer's own control resolves.
#[must_use]
pub fn command_declined(store: &Store, command: Command) -> bool {
	if matches!(command, Command::ToggleDrawer) {
		return !drawer_offered(&store.capabilities);
	}
	command
		.capability()
		.is_some_and(|capability| unavailable(store, capability))
}

/// Whether the host declared `capability` unavailable.
#[must_use]
pub const fn unavailable(store: &Store, capability: Capability) -> bool {
	matches!(store.capabilities.get(capability), CapabilityStatus::Unavailable { .. })
}

/// Fills the bar's declined set from what the host offers, and moves the
/// keyboard off an entry that has just been declined.
///
/// The set is rebuilt on every projection, so a host that withdraws terminals
/// while a menu is open refuses the drawer's entry in the next frame rather
/// than on the next press.
pub fn project_menu(store: &Store, menu: &mut MenuState) {
	menu.declined = MenuSectionId::iter()
		.flat_map(|section| section.entries().iter().copied())
		.filter(|command| command_declined(store, *command))
		.collect();
	if let Some(section) = menu.open {
		let entries = section.entries();
		let standing = entries
			.get(menu.highlighted)
			.copied()
			.is_some_and(|command| menu.enabled(command));
		if !standing {
			// Forward from where it stands, which lands on the first offered
			// entry below it, or wraps to the first one above.
			menu.move_highlight(1);
		}
	}
}
