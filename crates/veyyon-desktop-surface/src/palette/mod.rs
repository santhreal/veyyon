//! Command palette surface (§5.8).
//!
//! A floating glass surface providing fuzzy-searchable commands, sessions,
//! files, content search, and project directory browsing.

pub mod commands;
pub mod matcher;
pub mod modes;
pub mod motion;
mod rank;
mod render;
pub mod rows;

pub use self::{matcher::*, modes::*, render::*, rows::*};
use crate::{
	Intent,
	model::{Row, Section},
};

/// Active state of the command palette overlay (§5.8).
///
/// The query, the items and the route decide the row order, so each is written
/// through a method that ranks once. Ranking is the expensive part of the
/// surface and a frame only reads `filtered_items`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteState {
	/// Current search query string.
	query:           String,
	/// Active palette operating mode.
	pub mode:        PaletteMode,
	/// Index of the currently highlighted result row.
	pub selected:    usize,
	/// Candidate items available for matching in the active mode.
	items:           Vec<PaletteItem>,
	/// The ranked row order, as indices into `items`.
	rows:            Vec<usize>,
	/// Path components for directory navigation in Browse mode.
	pub browse_path: Vec<String>,
	/// Optional root path for project browsing.
	pub browse_root: Option<String>,
	/// Optional availability notice (e.g. host-provided unavailability reason).
	pub notice:      Option<String>,
	/// Command group shown in the shared navigation surface.
	route:           Option<crate::navigation::SurfaceRoute>,
}
impl Default for PaletteState {
	fn default() -> Self {
		Self::commands()
	}
}

impl PaletteState {
	#[must_use]
	pub const fn new(mode: PaletteMode) -> Self {
		Self {
			query: String::new(),
			mode,
			selected: 0,
			items: Vec::new(),
			rows: Vec::new(),
			browse_path: Vec::new(),
			browse_root: None,
			notice: None,
			route: None,
		}
	}

	/// Creates a palette state initialized with default commands.
	#[must_use]
	pub fn commands() -> Self {
		let mut state = Self::new(PaletteMode::Commands);
		state.route = Some(crate::navigation::SurfaceRoute::Commands);
		state.set_items(commands::command_items());
		state
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
					Some(PaletteMeta::Note(section.label().to_string())),
				));
			}
		}
		let mut state = Self::new(PaletteMode::Sessions);
		state.set_items(items);
		state
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

	/// Creates a palette state listing the host's model catalog under a heading
	/// per provider, the provider holding the model in effect first and that
	/// model first within it (§5.4). Choosing a row asks the host to select it.
	#[must_use]
	pub fn from_models(model: &crate::composer::ModelControl) -> Self {
		let mut providers: Vec<&str> = Vec::new();
		for option in &model.options {
			if !providers.contains(&option.choice.provider.as_str()) {
				providers.push(&option.choice.provider);
			}
		}
		// The provider holding the model in effect leads, so the operator's own
		// account is the first heading rather than whichever the host listed.
		if let Some(current) = &model.current
			&& let Some(position) = providers
				.iter()
				.position(|provider| *provider == current.provider.as_str())
		{
			let held = providers.remove(position);
			providers.insert(0, held);
		}
		let mut items: Vec<PaletteItem> = Vec::new();
		for provider in providers {
			let mut group: Vec<&crate::composer::ModelOption> = model
				.options
				.iter()
				.filter(|option| option.choice.provider == provider)
				.collect();
			if let Some(current) = &model.current
				&& let Some(position) = group.iter().position(|option| option.choice == *current)
			{
				let active = group.remove(position);
				group.insert(0, active);
			}
			for option in group {
				let current = model
					.current
					.as_ref()
					.is_some_and(|choice| *choice == option.choice);
				let mut marks: Vec<&str> = Vec::new();
				if current {
					marks.push("in effect");
				}
				if option.reasoning {
					marks.push("reasoning");
				}
				items.push(PaletteItem {
					id:       items.len() as u64 + 1,
					title:    option.name.clone(),
					// The heading above states the provider and the title states
					// the name, so a second line is drawn only for an id neither
					// of them has already stated.
					subtitle: (option.name != option.choice.model).then(|| option.choice.model.clone()),
					group:    Some(provider.to_owned()),
					// The heading holds the provider and the row holds the id, so
					// the qualified name is a query the row answers without
					// drawing it twice.
					search:   Some(format!("{provider}/{}", option.choice.model)),
					badge:    None,
					meta:     PaletteMeta::note(&marks),
					kind:     PaletteItemKind::Command {
						intent: Box::new(Intent::SelectModel(option.choice.clone())),
					},
				});
			}
		}
		let mut state = Self::new(PaletteMode::Models);
		state.set_items(items);
		state
	}

	/// The first row a list can draw and still reach `selected` inside `room`
	/// pixels, counting the `header_height` each group change costs and holding
	/// the eight-row window the surface pages by.
	///
	/// The walk starts at the selected row, so the selection is always one of
	/// the rows drawn however many headings the rows above it carry.
	#[must_use]
	pub fn window_start(
		items: &[&PaletteItem],
		selected: usize,
		room: f32,
		row_height: f32,
		header_height: f32,
	) -> usize {
		if items.is_empty() {
			return 0;
		}
		let group = |index: usize| items[index].group.as_deref();
		let top = |index: usize| {
			if group(index).is_some() {
				header_height
			} else {
				0.0
			}
		};
		let selected = selected.min(items.len() - 1);
		let mut start = selected;
		let mut rows = row_height;
		while start > 0 && selected - start < 7 {
			let above = start - 1;
			let mut next = rows + row_height;
			if group(start) != group(above) {
				next += header_height;
			}
			if next + top(above) > room {
				break;
			}
			rows = next;
			start = above;
		}
		start
	}

	/// The query the rows are ranked against.
	#[must_use]
	pub fn query(&self) -> &str {
		&self.query
	}

	/// Updates the search query, ranks the rows once, and resets the
	/// selection.
	pub fn set_query(&mut self, query: impl Into<String>) {
		self.query = query.into();
		self.selected = 0;
		self.rank();
	}

	/// Every candidate the mode carries, in the order it was authored.
	#[must_use]
	pub fn items(&self) -> &[PaletteItem] {
		&self.items
	}

	/// Replaces the candidates and ranks them once. The host relists a mode as
	/// its own state changes, so this is the only write path.
	pub fn set_items(&mut self, items: Vec<PaletteItem>) {
		self.items = items;
		self.rank();
		if self.selected >= self.rows.len() {
			self.selected = 0;
		}
	}

	/// Drops the candidates `keep` rejects and ranks what is left.
	///
	/// A command the host declines is not listed rather than listed and
	/// refused (§5.13), and the projection runs while the palette is open.
	pub fn retain_items(&mut self, keep: impl FnMut(&PaletteItem) -> bool) {
		self.items.retain(keep);
		self.rank();
		if self.selected >= self.rows.len() {
			self.selected = 0;
		}
	}

	/// The command group the shared navigation surface is showing.
	#[must_use]
	pub const fn route(&self) -> Option<crate::navigation::SurfaceRoute> {
		self.route
	}

	/// Moves to another command group and ranks the rows the group owns.
	pub fn set_route(&mut self, route: Option<crate::navigation::SurfaceRoute>) {
		self.route = route;
		self.selected = 0;
		self.rank();
	}

	/// Ranks the rows for the query, the items and the route now held.
	///
	/// Every write path ends here and a frame never does, which is what keeps
	/// a catalogue of thousands of rows off the render path.
	fn rank(&mut self) {
		self.rows = rank::rank_rows(&self.query, &self.items, self.route);
	}

	/// Adjusts the selection index by `delta`, wrapping within the ranked rows.
	pub const fn move_selection(&mut self, delta: i32) {
		let count = self.rows.len();
		if count == 0 {
			self.selected = 0;
			return;
		}
		let current = self.selected as i32;
		let next = (current + delta).rem_euclid(count as i32);
		self.selected = next as usize;
	}

	/// The rows in ranked order, as the surface draws them.
	#[must_use]
	pub fn filtered_items(&self) -> Vec<&PaletteItem> {
		self
			.rows
			.iter()
			.filter_map(|index| self.items.get(*index))
			.collect()
	}

	/// Returns the currently highlighted item if one exists.
	#[must_use]
	pub fn selected_item(&self) -> Option<&PaletteItem> {
		self
			.rows
			.get(self.selected)
			.and_then(|index| self.items.get(*index))
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
		self.selected = 0;
		self.set_query(String::new());
	}
}
