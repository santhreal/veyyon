//! Settings surface layout, pages, and control presentation (§5.9).
//!
//! Renders the modal settings overlay across ten categorical pages: General,
//! Themes, Keybindings, Providers, Authentication, MCP, Extensions,
//! Diagnostics, Usage, and `ContextBreakdown`.

pub mod body;
pub mod pages;
pub mod row;

use serde_json::Value;
use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_model::{
	AgentView, AuthFlowView, ContextBreakdownView, KeybindingView, McpServerView, ProviderView,
	SettingEntry, SettingsView, ThemesView, UsageTotals,
};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

pub use self::{body::*, pages::*, row::*};
use crate::{Intent, ShellView, controls::ControlStates};

/// Runtime view model for the settings overlay (§5.9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsState {
	/// Currently selected settings category page.
	pub page:         SettingsPage,
	/// Every setting the host reports, keyed by schema key; empty until
	/// `LoadSettings` answers.
	pub settings:     SettingsView,
	/// Available UI color themes.
	pub themes:       Option<ThemesView>,
	/// Keymap shortcut definitions.
	pub keybindings:  Vec<KeybindingView>,
	/// Configured AI model providers.
	pub providers:    Vec<ProviderView>,
	/// Active OAuth authorization flow state.
	pub auth_flow:    Option<AuthFlowView>,
	/// Model Context Protocol servers and tools.
	pub mcp:          Vec<McpServerView>,
	/// Registered subagents and task execution extensions.
	pub extensions:   Vec<AgentView>,
	/// Telemetry and subsystem diagnostic entries.
	pub diagnostics:  Option<Value>,
	/// Token usage metrics and accumulated costs.
	pub usage:        Option<UsageTotals>,
	/// Context window allocation breakdown.
	pub context:      Option<ContextBreakdownView>,
	/// Reloading / refreshing indicator.
	pub reloading:    bool,
	/// Selected row index for keyboard navigation.
	pub selected_row: Option<usize>,
}

impl Default for SettingsState {
	fn default() -> Self {
		Self::new(SettingsPage::General)
	}
}

impl SettingsState {
	/// Creates an empty settings state for a given category page.
	#[must_use]
	pub const fn new(page: SettingsPage) -> Self {
		Self {
			page,
			settings: SettingsView::new(),
			themes: None,
			keybindings: Vec::new(),
			providers: Vec::new(),
			auth_flow: None,
			mcp: Vec::new(),
			extensions: Vec::new(),
			diagnostics: None,
			usage: None,
			context: None,
			reloading: false,
			selected_row: None,
		}
	}

	/// Creates a settings state holding the given entries.
	#[must_use]
	pub fn general(settings: SettingsView) -> Self {
		let mut state = Self::new(SettingsPage::General);
		state.settings = settings;
		state
	}

	/// Looks up a setting by key.
	#[must_use]
	pub fn entry(&self, key: &str) -> Option<&SettingEntry> {
		self.settings.get(key)
	}
}

/// Renders the complete settings overlay dialog with sidebar and page contents
/// (§5.9).
pub fn settings_surface(
	state: &SettingsState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let radius = tokens.radius(RadiusStep::Xl);
	let bg = tokens.color(ColorRole::Float);
	let border = tokens.color(ColorRole::Hairline);
	let pad = tokens.spacing(SpacingStep::S6);

	let mut dialog = div()
		.id("settings-dialog")
		.w(px(860.0))
		.h(px(560.0))
		.rounded(radius)
		.bg(bg)
		.border_1()
		.border_color(border)
		.shadow_lg()
		.flex()
		.flex_row()
		.overflow_hidden();

	// Left sidebar (200px width).
	let mut sidebar = div()
		.w(px(200.0))
		.h_full()
		.border_r_1()
		.border_color(border)
		.p(tokens.spacing(SpacingStep::S4))
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.overflow_hidden();

	sidebar = sidebar.child(
		div()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S2))
			.text_size(tokens.font_size(TextRamp::Head))
			.font_weight(tokens.font_weight(TextWeight::Semibold))
			.text_color(tokens.color(ColorRole::Foreground))
			.child("Settings"),
	);

	use strum::IntoEnumIterator;
	for page in SettingsPage::iter() {
		let is_active = page == state.page;
		let tab_bg = if is_active {
			tokens.row_selected()
		} else {
			tokens.transparent()
		};
		let tab_text_color = if is_active {
			tokens.color(ColorRole::Foreground)
		} else {
			tokens.color(ColorRole::Secondary)
		};

		let page_btn = div()
			.id(("settings-tab", page as usize))
			.h(px(32.0))
			.px(tokens.spacing(SpacingStep::S3))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tab_bg)
			.hover(move |s| s.bg(tokens.row_hover()))
			.flex()
			.items_center()
			.cursor_pointer()
			.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
				view.dispatch(
					Intent::OpenOverlay(Box::new(crate::overlay::Overlay::Settings(Box::new(
						SettingsState {
							page,
							..view.state().overlay_settings().cloned().unwrap_or_default()
						},
					)))),
					cx,
				);
			}))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.font_weight(if is_active {
						tokens.font_weight(TextWeight::Medium)
					} else {
						tokens.font_weight(TextWeight::Regular)
					})
					.text_color(tab_text_color)
					.child(page.title()),
			);
		sidebar = sidebar.child(page_btn);
	}
	dialog = dialog.child(sidebar);

	// Right content area.
	let mut content = div()
		.flex_1()
		.h_full()
		.p(pad)
		.flex()
		.flex_col()
		.overflow_hidden();

	// Page Header.
	let header = div()
		.mb(px(geometry.group_gap))
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Head))
				.font_weight(tokens.font_weight(TextWeight::Semibold))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(state.page.title()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(state.page.description()),
		);
	content = content.child(header);

	// Page body rows container.
	let body = render_page_body(state, controls, geometry, tokens, cx);
	content = content.child(body);

	dialog.child(content)
}
