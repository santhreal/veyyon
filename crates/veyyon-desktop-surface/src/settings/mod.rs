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
use veyyon_desktop_kit::{SpacingStep, TokenSet};
use veyyon_desktop_model::{
	AgentView, AuthFlowView, ContextBreakdownView, KeybindingView, McpServerView, ProviderView,
	SettingEntry, SettingsView, SurfaceId, ThemesView, UsageTotals,
};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, div,
};

pub use self::{
	body::{general::*, *},
	pages::*,
	row::*,
};
use crate::{
	ShellView,
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
	/// The page the operator routed to, when a route reached this state; a
	/// state built without one names its own page.
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

/// Renders the settings page the operator routed to, in the sheet the float
/// sizes from `surface/settings.toml` (§5.9).
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
	// Every path to this surface routes a page: the palette's settings row and
	// `primary-,` both navigate `SurfaceRoute::Settings`, whose rows navigate
	// `SurfaceRoute::Page`. A state carrying no route is one a caller built
	// directly, and it names the page it was built for.
	let route = state
		.route
		.unwrap_or(crate::navigation::SurfaceRoute::Page(state.page));
	focused::focused_surface(
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
	)
}
