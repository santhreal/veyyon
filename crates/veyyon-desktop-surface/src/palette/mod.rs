//! Command palette surface (§5.8).
//!
//! A floating glass surface providing fuzzy-searchable commands, sessions,
//! files, content search, and project directory browsing.

pub mod commands;
pub mod matcher;
pub mod modes;
pub mod motion;
mod render;
pub mod rows;

pub use self::{matcher::*, modes::*, render::*, rows::*};
use crate::{
	Intent,
	model::{Row, Section},
};

/// Active state of the command palette overlay (§5.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteState {
	/// Current search query string.
	pub query:       String,
	/// Active palette operating mode.
	pub mode:        PaletteMode,
	/// Index of the currently highlighted result row.
	pub selected:    usize,
	/// Candidate items available for matching in the active mode.
	pub items:       Vec<PaletteItem>,
	/// Path components for directory navigation in Browse mode.
	pub browse_path: Vec<String>,
	/// Optional root path for project browsing.
	pub browse_root: Option<String>,
}

impl Default for PaletteState {
	fn default() -> Self {
		Self::commands()
	}
}

impl PaletteState {
	/// Creates an empty palette state for the specified mode.
	#[must_use]
	pub const fn new(mode: PaletteMode) -> Self {
		Self {
			query: String::new(),
			mode,
			selected: 0,
			items: Vec::new(),
			browse_path: Vec::new(),
			browse_root: None,
		}
	}

	/// Creates a palette state initialized with default commands.
	#[must_use]
	pub fn commands() -> Self {
		let items = commands::command_items();
		Self {
			query: String::new(),
			mode: PaletteMode::Commands,
			selected: 0,
			items,
			browse_path: Vec::new(),
			browse_root: None,
		}
	}

	/// Creates a palette state populated with queue sessions.
	#[must_use]
	pub fn from_sessions(sections: &[(Section, Vec<Row>)]) -> Self {
		let mut items = Vec::new();
		for (section, rows) in sections {
			for row in rows {
				items.push(PaletteItem::session(
					row.id,
					row.title.clone(),
					row.subtitle.clone(),
					row.badge,
					Some(section.label().to_string()),
				));
			}
		}
		Self {
			query: String::new(),
			mode: PaletteMode::Sessions,
			selected: 0,
			items,
			browse_path: Vec::new(),
			browse_root: None,
		}
	}

	/// The intent running the highlighted row dispatches, for a row that is
	/// an action rather than a step of navigation: a command runs itself, a
	/// session opens, a file or a match opens its file. A directory row
	/// descends instead and returns `None`.
	#[must_use]
	pub fn run_intent(&self) -> Option<Intent> {
		match &self.selected_item()?.kind {
			PaletteItemKind::Command { intent } => Some((**intent).clone()),
			PaletteItemKind::Session { id } => Some(Intent::SelectSession(*id)),
			PaletteItemKind::File { path } | PaletteItemKind::ContentMatch { path, .. } => {
				Some(Intent::OpenFile(path.clone()))
			},
			PaletteItemKind::Directory { .. }
			| PaletteItemKind::Project { .. }
			| PaletteItemKind::Composer { .. } => None,
		}
	}

	/// Creates a palette state listing the host's model catalog, the current
	/// model first (§5.4). Choosing a row asks the host to select that model.
	#[must_use]
	pub fn from_models(model: &crate::composer::ModelControl) -> Self {
		let mut items: Vec<PaletteItem> = model
			.options
			.iter()
			.enumerate()
			.map(|(index, option)| PaletteItem {
				id:       index as u64 + 1,
				title:    option.name.clone(),
				subtitle: Some(format!("{}/{}", option.choice.provider, option.choice.model)),
				badge:    None,
				meta:     option.reasoning.then(|| "reasoning".to_string()),
				kind:     PaletteItemKind::Command {
					intent: Box::new(Intent::SelectModel(option.choice.clone())),
				},
			})
			.collect();
		if let Some(current) = &model.current
			&& let Some(position) = model
				.options
				.iter()
				.position(|option| option.choice == *current)
		{
			let active = items.remove(position);
			items.insert(0, active);
		}
		Self {
			query: String::new(),
			mode: PaletteMode::Models,
			selected: 0,
			items,
			browse_path: Vec::new(),
			browse_root: None,
		}
	}

	/// Updates the search query and resets selection index to 0.
	pub fn set_query(&mut self, query: impl Into<String>) {
		self.query = query.into();
		self.selected = 0;
	}

	/// Adjusts the selection index by `delta`, bounding it within filtered
	/// results.
	pub fn move_selection(&mut self, delta: i32) {
		let count = self.filtered_items().len();
		if count == 0 {
			self.selected = 0;
			return;
		}
		let current = self.selected as i32;
		let next = (current + delta).rem_euclid(count as i32);
		self.selected = next as usize;
	}

	/// Returns references to candidate items ranked by fuzzy score against
	/// `query`.
	#[must_use]
	pub fn filtered_items(&self) -> Vec<&PaletteItem> {
		if self.query.is_empty() {
			return self.items.iter().collect();
		}
		let ranked = fuzzy_rank(&self.query, &self.items, |item| &item.title);
		ranked.into_iter().map(|(_, _, item)| item).collect()
	}

	/// Returns the currently highlighted item if one exists.
	#[must_use]
	pub fn selected_item(&self) -> Option<&PaletteItem> {
		let filtered = self.filtered_items();
		filtered.get(self.selected).copied()
	}

	/// Ascends one directory level in Browse mode. Returns `true` if ascended.
	pub fn ascend(&mut self) -> bool {
		if self.mode == PaletteMode::Browse && !self.browse_path.is_empty() {
			self.browse_path.pop();
			self.selected = 0;
			true
		} else {
			false
		}
	}

	/// Descends into a directory child in Browse mode.
	pub fn descend(&mut self, dir_name: impl Into<String>) {
		self.browse_path.push(dir_name.into());
		self.query.clear();
		self.selected = 0;
	}
}
