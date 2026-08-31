//! Dispatcher matching UI commands across navigation, composer, selection,
//! preferences, and host domains.

mod composer;
mod history;
mod host;
mod navigation;
pub mod notify;
mod preferences;
mod review;
mod selection;
mod spaces;

#[cfg(test)]
mod a_tab_closes_with_confirmation_when_dirty_and_clean_without;
#[cfg(test)]
mod every_space_and_tab_command_changes_state_or_is_refused;
#[cfg(test)]
mod switching_spaces_restores_tabs_and_panel_layout;
#[cfg(test)]
mod the_active_session_always_equals_the_active_tab_or_both_none;
#[cfg(test)]
mod the_interface_text_size_steps_through_the_sizes_the_page_offers;

use crate::{
	command::UiCommand,
	store::{Effects, Store},
};

pub(crate) fn toggle_set<T: Ord>(set: &mut std::collections::BTreeSet<T>, value: T) {
	if !set.remove(&value) {
		set.insert(value);
	}
}

impl Store {
	pub fn dispatch(&mut self, command: UiCommand) -> Effects {
		let mut effects = Effects::default();
		if self.dispatch_spaces(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_navigation(&command, &mut effects) {
			if let Some(space) = self.frontend.spaces.active_mut() {
				space.panels = self.frontend.panels.clone();
				space.bottom_tab = self.frontend.bottom_tab;
				space.inspector_tab = self.frontend.inspector_tab;
			}
			return effects;
		}
		if self.dispatch_history(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_composer(command.clone(), &mut effects) {
			return effects;
		}
		if self.dispatch_selection(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_review(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_notify(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_preferences(&command, &mut effects) {
			return effects;
		}
		self.dispatch_host(command, &mut effects);
		effects
	}
}
