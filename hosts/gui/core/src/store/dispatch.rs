//! Dispatcher matching UI commands across navigation, composer, selection,
//! preferences, and host domains.

mod composer;
mod host;
mod navigation;
mod preferences;
mod selection;

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
		if self.dispatch_navigation(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_composer(command.clone(), &mut effects) {
			return effects;
		}
		if self.dispatch_selection(&command, &mut effects) {
			return effects;
		}
		if self.dispatch_preferences(&command, &mut effects) {
			return effects;
		}
		self.dispatch_host(command, &mut effects);
		effects
	}
}
