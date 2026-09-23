//! Page body row construction for settings categories (§5.9).
//!
//! Dispatches category-specific row rendering through specialized per-page
//! modules with capability gate availability checks.

pub mod auth;
pub mod conditions;
pub mod context;
pub mod diagnostics;
pub mod extensions;
pub mod general;
pub mod general_control;
pub mod keybindings;
pub mod mcp;
pub mod profiles;
pub mod providers;
pub mod themes;
pub mod usage;

use veyyon_desktop_kit::{Axis, ColorRole, ScrollView, TokenSet};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, IntoElement, ParentElement, Styled, div, px};

use super::{GeneralSettingsListState, SettingsPage, SettingsState};
use crate::{
	ShellView, controls::ControlStates, model::AppearanceChoice, shell::fields::FieldSlots,
};

/// Renders the rows for the currently active settings page (§5.9).
pub fn render_page_body(
	state: &SettingsState,
	list_state: &GeneralSettingsListState,
	appearance: &AppearanceChoice,
	fields: &FieldSlots,
	picker_scroll: &veyyon_gpui::ScrollHandle,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut container = div()
		.flex_1()
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_hidden();

	let body_content = match state.page {
		SettingsPage::General => {
			general::render_general_page(state, list_state, fields, controls, geometry, tokens, cx)
		},
		SettingsPage::Themes => themes::render_themes_page(
			state,
			appearance,
			controls,
			picker_scroll,
			geometry,
			tokens,
			cx,
		),
		SettingsPage::Keybindings => {
			keybindings::render_keybindings_page(state, fields, controls, geometry, tokens)
		},
		SettingsPage::Providers => {
			providers::render_providers_page(state, controls, geometry, tokens, cx)
		},
		SettingsPage::Authentication => {
			auth::render_auth_page(state, fields.secret.clone(), controls, geometry, tokens, cx)
		},
		SettingsPage::Mcp => mcp::render_mcp_page(state, controls, geometry, tokens, cx),
		SettingsPage::Extensions => {
			extensions::render_extensions_page(state, fields, controls, geometry, tokens, cx)
		},
		SettingsPage::Diagnostics => {
			diagnostics::render_diagnostics_page(state, controls, geometry, tokens, cx)
		},
		SettingsPage::Usage => usage::render_usage_page(state, controls, geometry, tokens, cx),
		SettingsPage::ContextBreakdown => {
			context::render_context_page(state, controls, geometry, tokens)
		},
		SettingsPage::Profiles => {
			profiles::render_profiles_page(state, fields, controls, geometry, tokens, cx)
		},
	};

	if matches!(state.page, SettingsPage::General | SettingsPage::Themes) {
		return container.min_h_0().child(body_content);
	}

	// The body scrolls along one axis: a page longer than the overlay is
	// reached by scrolling, never by a second column.
	// The fade states that content continues past the edge, so it falls off to
	// the ground it is drawn on. The kit's default is the canvas, which is
	// darker than the sheet: over this ground it draws two bars across a page
	// that has nothing to scroll.
	container = container.child(
		ScrollView::new(body_content)
			.axis(Axis::Vertical)
			.fade_color(tokens.color(ColorRole::Float)),
	);
	container
}
