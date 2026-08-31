//! Palette item, group, results, and source state models.

use crate::UiCommand;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
	pub id:              String,
	pub title:           String,
	pub detail:          Option<String>,
	pub disabled_reason: Option<String>,
	pub current:         bool,
	pub commands:        Vec<UiCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
	pub id:    &'static str,
	pub label: &'static str,
	pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceState {
	Ready,
	Loading,
	Empty,
	Stale(String),
	Error { message: String, retryable: bool },
	Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Results {
	pub groups: Vec<Group>,
	pub state:  SourceState,
}
