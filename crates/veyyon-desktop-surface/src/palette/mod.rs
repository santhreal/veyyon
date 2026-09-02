//! Command palette surface (§5.8).
//!
//! A floating glass surface providing fuzzy-searchable commands, sessions,
//! files, content search, and project directory browsing.

pub mod matcher;
pub mod modes;
pub mod rows;

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp,
	TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_tokens::{PaletteSurfaceTokens, QueueSurfaceTokens};
use veyyon_gpui::{Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px};

pub use self::{matcher::*, modes::*, rows::*};
use crate::{
	Intent, ShellView,
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
		let items = vec![
			PaletteItem::command(1, "New Session", Intent::NewSession, Some("Cmd+N")),
			PaletteItem::command(
				2,
				"Open Settings",
				Intent::OpenOverlay(Box::new(crate::overlay::Overlay::Settings(Box::new(
					crate::settings::SettingsState::new(crate::settings::SettingsPage::General),
				)))),
				Some("Cmd+,"),
			),
			PaletteItem::command(
				3,
				"Toggle Terminal Drawer",
				Intent::SetDrawer { open: true },
				Some("Cmd+J"),
			),
			PaletteItem::command(
				4,
				"Switch Theme",
				Intent::OpenOverlay(Box::new(crate::overlay::Overlay::Settings(Box::new(
					crate::settings::SettingsState::new(crate::settings::SettingsPage::Themes),
				)))),
				None,
			),
			PaletteItem::command(5, "Reload Configuration", Intent::ReloadSettings, None),
		];
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
			PaletteItemKind::Directory { .. } | PaletteItemKind::Project { .. } => None,
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

/// Renders the floating command palette overlay element (§5.8).
pub fn palette_surface(
	state: &PaletteState,
	geometry: &PaletteSurfaceTokens,
	queue_geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let width = px(geometry.width_px);
	let max_height = px(geometry.max_height_px);
	let radius = tokens.radius(RadiusStep::Xl);
	let bg = tokens.color(ColorRole::Float);
	let border = tokens.color(ColorRole::Hairline);
	let input_height = px(geometry.input_row_height_px);
	let icon_size = px(geometry.input_search_icon_px);
	let inset = px(geometry.input_inset);

	let mut container = div()
		.id("command-palette")
		.w(width)
		.max_h(max_height)
		.rounded(radius)
		.bg(bg)
		.border_1()
		.border_color(border)
		.shadow_lg()
		.flex()
		.flex_col()
		.overflow_hidden();

	// Input row (40px with search icon and mode badge).
	let mode_badge = BadgeChip::new(state.mode.label(), TintRole::Plan);
	let input_row = div()
		.h(input_height)
		.px(inset)
		.border_b_1()
		.border_color(border)
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(
			div()
				.w(icon_size)
				.h(icon_size)
				.flex_shrink_0()
				.flex()
				.items_center()
				.justify_center()
				.child(
					Icon::new(IconName::Search)
						.size(IconSize::Size16)
						.color(tokens.color(ColorRole::Muted)),
				),
		)
		.child(
			div()
				.flex_1()
				.text_size(tokens.font_size(TextRamp::Body))
				.text_color(if state.query.is_empty() {
					tokens.color(ColorRole::Muted)
				} else {
					tokens.color(ColorRole::Foreground)
				})
				.child(if state.query.is_empty() {
					state.mode.placeholder().to_string()
				} else {
					state.query.clone()
				}),
		)
		.child(mode_badge);
	container = container.child(input_row);

	// Group Header (20px).
	let header = div()
		.h(px(geometry.results_group_header_height_px))
		.px(inset)
		.flex()
		.items_center()
		.text_size(tokens.font_size(TextRamp::Micro))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::Muted))
		.child(state.mode.label());
	container = container.child(header);

	// Result rows (32px line rows).
	let filtered = state.filtered_items();
	let mut results_list = div().flex_1().flex().flex_col().overflow_hidden();

	if filtered.is_empty() {
		results_list = results_list.child(
			div()
				.h(px(geometry.results_row_height_px))
				.px(inset)
				.flex()
				.items_center()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("No matching items"),
		);
	} else {
		for (idx, item) in filtered.iter().enumerate() {
			let is_selected = idx == state.selected;
			let row = item.to_row();
			results_list =
				results_list.child(palette_line_row(&row, is_selected, queue_geometry, tokens, cx));
		}
	}
	container = container.child(results_list);

	// Footer (32px with key hints at 11px micro).
	let footer = div()
		.h(px(geometry.results_footer_height_px))
		.px(inset)
		.border_t_1()
		.border_color(border)
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(
			div()
				.flex()
				.flex_row()
				.gap(tokens.spacing(SpacingStep::S4))
				.child("↑↓ Navigate")
				.child(if state.mode == PaletteMode::Browse {
					"↵ Descend"
				} else {
					"↵ Run"
				})
				.child("⌫ Ascend"),
		)
		.child(div().child("Esc Close"));
	container = container.child(footer);

	container
}
