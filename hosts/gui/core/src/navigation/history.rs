//! History navigation, grouping, filtering, and disclosure state.

use std::collections::BTreeSet;

/// How sessions are grouped in the history surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum HistoryGroupBy {
	#[default]
	Date,
	Repository,
}

impl HistoryGroupBy {
	pub const ALL: [Self; 2] = [Self::Date, Self::Repository];

	pub const fn label(self) -> &'static str {
		match self {
			Self::Date => "By Date",
			Self::Repository => "By Repository",
		}
	}
}

/// Navigation and disclosure state for the History view.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct HistoryNavState {
	pub filter:           String,
	pub group_by:         HistoryGroupBy,
	pub collapsed_groups: BTreeSet<String>,
}

impl HistoryNavState {
	pub fn is_collapsed(&self, group_key: &str) -> bool {
		self.collapsed_groups.contains(group_key)
	}

	pub fn toggle_group(&mut self, group_key: &str) {
		if !self.collapsed_groups.remove(group_key) {
			self.collapsed_groups.insert(group_key.to_owned());
		}
	}

	pub fn collapse_all(&mut self, groups: impl IntoIterator<Item = impl Into<String>>) {
		for group in groups {
			self.collapsed_groups.insert(group.into());
		}
	}

	pub fn expand_all(&mut self) {
		self.collapsed_groups.clear();
	}
}
