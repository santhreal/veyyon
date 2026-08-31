//! History navigation and disclosure commands.

use crate::{
	command::UiCommand,
	store::{Effects, Store},
};

impl Store {
	pub(super) fn dispatch_history(&mut self, command: &UiCommand, _effects: &mut Effects) -> bool {
		match command {
			UiCommand::SetHistoryFilter(filter) => {
				self.frontend.history.filter = filter.clone();
				true
			},
			UiCommand::SetHistoryGroupBy(group_by) => {
				self.frontend.history.group_by = *group_by;
				true
			},
			UiCommand::ToggleHistoryGroup(group) => {
				self.frontend.history.toggle_group(group);
				true
			},
			UiCommand::CollapseAllHistoryGroups => {
				// Mark all groups collapsed or let caller populate
				true
			},
			UiCommand::ExpandAllHistoryGroups => {
				self.frontend.history.expand_all();
				true
			},
			_ => false,
		}
	}
}
