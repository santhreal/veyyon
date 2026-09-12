//! Command palette surface (§5.8).
//!
//! A floating glass surface providing fuzzy-searchable commands, sessions,
//! files, content search, and project directory browsing.

pub mod commands;
mod interaction;
pub mod matcher;
pub mod modes;
pub mod motion;
mod rank;
mod render;
pub mod rows;

use veyyon_desktop_model::Capability;

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
	query:        String,
	/// Active palette operating mode.
	pub mode:     PaletteMode,
	/// Index of the currently highlighted result row.
	pub selected: usize,
	/// Candidate items available for matching in the active mode.
	items:        Vec<PaletteItem>,
	/// The ranked row order, as indices into `items`.
	rows:         Vec<usize>,
	/// The directory Browse mode is listing, workspace-relative, or `None` for
	/// the workspace root. The host is asked for this directory's children, so
	/// the rows are one level and the parent is what an ascent reads off it.
	browse_root:  Option<String>,
	/// Optional availability notice (e.g. host-provided unavailability reason).
	pub notice:   Option<String>,
	/// Command group shown in the shared navigation surface.
	route:        Option<crate::navigation::SurfaceRoute>,
	/// Host-ranked results must not be filtered again against visible labels.
	host_ranked:  bool,
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
			browse_root: None,
			notice: None,
			route: None,
			host_ranked: false,
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
					id:         items.len() as u64 + 1,
					title:      option.name.clone(),
					// The heading above states the provider and the title states
					// the name, so a second line is drawn only for an id neither
					// of them has already stated.
					subtitle:   (option.name != option.choice.model)
						.then(|| option.choice.model.clone()),
					group:      Some(provider.to_owned()),
					// The heading holds the provider and the row holds the id, so
					// the qualified name is a query the row answers without
					// drawing it twice.
					search:     Some(format!("{provider}/{}", option.choice.model)),
					badge:      None,
					meta:       PaletteMeta::note(&marks),
					capability: Some(Capability::Models),
					kind:       PaletteItemKind::Command {
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
		veyyon_desktop_kit::Picker::new(items, selected).window_start(
			room,
			row_height,
			header_height,
			|item| item.group.as_deref(),
		)
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

	/// Installs results already matched and ordered by the host.
	pub fn set_host_items(&mut self, items: Vec<PaletteItem>) {
		self.host_ranked = true;
		self.set_items(items);
	}

	/// Persisted-session search uses host matching, unlike queue session
	/// filtering.
	#[must_use]
	pub fn history(query: String) -> Self {
		let mut state = Self::new(PaletteMode::Sessions);
		state.host_ranked = true;
		state.set_query(query);
		state
	}

	#[must_use]
	pub fn is_history(&self) -> bool {
		self.mode == PaletteMode::Sessions && self.host_ranked
	}

	#[must_use]
	pub fn query_intent(&self, query: String) -> Intent {
		if self.is_history() {
			Intent::FindSessions(query)
		} else {
			self.mode.query_intent(query)
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
		self.rows =
			rank::rank_rows(if self.host_ranked { "" } else { &self.query }, &self.items, self.route);
	}

	/// Adjusts the selection index by `delta`, wrapping within the ranked rows.
	pub fn move_selection(&mut self, delta: i32) {
		if let veyyon_desktop_kit::PickerEvent::Select(index) =
			veyyon_desktop_kit::Picker::new(&self.rows, self.selected).step(delta, |_| true)
		{
			self.selected = index;
		}
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

	/// The directory being listed, or `None` at the workspace root.
	#[must_use]
	pub fn browse_root(&self) -> Option<&str> {
		self.browse_root.as_deref()
	}

	/// The directory one level above the one being listed, and whether there
	/// is one to ascend to: `Some(None)` is the workspace root, and `None`
	/// means the palette is already there or is not browsing.
	#[must_use]
	pub fn browse_parent(&self) -> Option<Option<String>> {
		if self.mode != PaletteMode::Browse {
			return None;
		}
		let root = self.browse_root.as_deref()?;
		Some(root.rsplit_once('/').map(|(parent, _)| parent.to_owned()))
	}

	/// Lists another directory: the rows the projection fills come from the
	/// host's listing of it, so the selection and the query start over.
	pub fn browse_to(&mut self, path: Option<String>) {
		self.browse_root = path;
		self.selected = 0;
		self.set_query(String::new());
	}
}
