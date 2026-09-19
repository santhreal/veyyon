//! Settings surface layout, pages, and control presentation (§5.9).
//!
//! Renders the modal settings overlay across ten categorical pages: General,
//! Themes, Keybindings, Providers, Authentication, MCP, Extensions,
//! Diagnostics, Usage, and `ContextBreakdown`.

pub mod body;
pub mod empty;
mod focused;
pub mod pages;
pub mod row;

use serde_json::Value;
use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp,
	TextWeight, TokenSet,
};
use veyyon_desktop_model::{
	AgentView, AuthFlowView, ContextBreakdownView, KeybindingView, McpServerView, ProviderView,
	SettingEntry, SettingsView, SurfaceId, ThemesView, UsageTotals,
};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, FocusHandle, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

pub use self::{
	body::{general::*, *},
	pages::*,
	row::*,
};
use crate::{
	Intent, ShellView,
	controls::{ControlError, ControlStates, error_hairline},
	model::AppearanceChoice,
	shell::fields::FieldSlots,
};

/// The failure the host sent for a control the settings sheet draws, with the
/// control it landed on.
///
/// Every page of the sheet sends requests -- a setting written, a setting
/// reset, a binding rebound, a theme selected, a server enabled, a source
/// re-run, a task spawned, a provider signed into -- and the refusal the
/// host answers with lands on the control that sent it. The sheet stated
/// none of them, so a setting the host would not write was reported on the
/// window's line, above the sheet and away from the field, and a sign-in it
/// refused reached nothing that draws at all. The surface travels with the
/// message because a retry sends the request that failed there, which the
/// surface id is the key to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsFailure {
	/// The control the failure landed on, and the key to the request it sent.
	pub surface: SurfaceId,
	/// What the host said, and whether it offered to be asked again.
	pub error:   ControlError,
}

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
	/// Focused command destination; absent for the complete settings dialog.
	pub route:        Option<crate::navigation::SurfaceRoute>,
	/// The host's failure for one of the sheet's own controls, restated every
	/// projection.
	pub failure:      Option<SettingsFailure>,
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
			route: None,
			failure: None,
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

/// The host's sentence for whatever the sheet last asked it for, drawn above
/// the page it was asked from, with the `Retry` that sends the refused
/// request again and the `Dismiss` that clears it (§4.4).
///
/// One row for every page, because the sheet is one surface the operator is
/// looking at and a request registers under one control. What lands here is
/// resolved every projection, so an error the operator dismissed is gone
/// from the next frame.
#[must_use]
pub fn settings_failure_row(
	state: &SettingsState,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Option<veyyon_gpui::Stateful<veyyon_gpui::Div>> {
	state.failure.as_ref().map(|failure| {
		div()
			.id("settings-failure")
			.flex_shrink_0()
			.w_full()
			.pb(tokens.spacing(SpacingStep::S2))
			.child(error_hairline(&failure.error, failure.surface.clone(), tokens, cx))
	})
}

/// Renders the complete settings overlay dialog with sidebar and page contents
/// (§5.9).
pub fn settings_surface(
	state: &SettingsState,
	list_state: &GeneralSettingsListState,
	appearance: &AppearanceChoice,
	fields: &FieldSlots,
	back: Option<crate::navigation::SurfaceRoute>,
	focus: Option<&FocusHandle>,
	picker_scroll: &veyyon_gpui::ScrollHandle,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	if let Some(route) = state.route {
		return focused::focused_surface(
			state,
			list_state,
			appearance,
			fields,
			route,
			back,
			focus,
			picker_scroll,
			controls,
			geometry,
			tokens,
			cx,
		);
	}
	let radius = tokens.radius(RadiusStep::Xl);
	let bg = tokens.color(ColorRole::Float);
	let stroke_px = tokens.stroke(StrokeStep::Hairline);
	let pad = tokens.spacing(SpacingStep::S6);

	let mut dialog = div().id("settings-dialog");
	if let Some(f) = focus {
		dialog = dialog.track_focus(f);
	}
	// The float that opens this surface already sizes the sheet from
	// `group_width_px` and `sheet_height_px` and clamps it to the viewport, so
	// the dialog fills the box rather than restating either measure.
	let mut dialog = dialog
		.key_context("Settings")
		.w_full()
		.h_full()
		.rounded(radius)
		.bg(bg)
		.border(stroke_px)
		.border_color(tokens.color(ColorRole::Hairline))
		.shadow_lg()
		.flex()
		.flex_row()
		.overflow_hidden()
		.on_action(cx.listener(
			|view, _: &veyyon_desktop_kit::input::editor::actions::Escape, _window, cx| {
				view.back_surface(cx);
				cx.stop_propagation();
				cx.notify();
			},
		))
		.on_action(cx.listener(|view, _: &crate::keymap::actions::Dismiss, _window, cx| {
			view.back_surface(cx);
			cx.stop_propagation();
			cx.notify();
		}));
	let mut sidebar = div()
		.w(px(geometry.sidebar_width_px))
		.h_full()
		.border_r(stroke_px)
		.border_color(tokens.color(ColorRole::Hairline))
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
			.h(tokens.spacing(SpacingStep::S11))
			.px(tokens.spacing(SpacingStep::S3))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tab_bg)
			.hover(move |s| s.bg(tokens.row_hover()))
			.flex()
			.items_center()
			.cursor_pointer()
			.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
				view.dispatch(Intent::PreviewAppearance(None), cx);
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
	let top_bar = div()
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2));

	let title_block = div()
		.flex_1()
		.min_w_0()
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

	let mut action_bar = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	if let Some(parent) = back {
		action_bar = action_bar.child(
			Button::new("settings-dialog-back", "Back")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| view.navigate_surface(parent, cx))),
		);
	}

	action_bar = action_bar.child(
		Button::new("settings-dialog-close", "Close")
			.size(ButtonSize::Small)
			.variant(ButtonVariant::Ghost)
			.on_click(cx.listener(|view, _, _, cx| view.close_palette(cx))),
	);

	let header = div()
		.mb(px(geometry.group_gap))
		.child(top_bar.child(title_block).child(action_bar));
	content = content.child(header);
	content = content.children(settings_failure_row(state, tokens, cx));

	// Page body rows container.
	let body = render_page_body(
		state,
		list_state,
		appearance,
		fields,
		picker_scroll,
		controls,
		geometry,
		tokens,
		cx,
	);
	content = content.child(body);
	dialog.child(content)
}
