//! Page body row construction for settings categories (§5.9).
//!
//! Dispatches category-specific row rendering through specialized per-page
//! modules with capability gate availability checks.

pub mod auth;
pub mod context;
pub mod diagnostics;
pub mod extensions;
pub mod general;
pub mod general_control;
pub mod keybindings;
pub mod mcp;
pub mod providers;
pub mod themes;
pub mod usage;

use veyyon_desktop_kit::{Axis, ScrollView, TokenSet};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, IntoElement, ParentElement, Styled, div, px};

use super::{SettingsPage, SettingsState};
use crate::{ShellView, controls::ControlStates};

/// Renders the rows for the currently active settings page (§5.9).
pub fn render_page_body(
	state: &SettingsState,
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
		SettingsPage::General => general::render_general_page(state, controls, geometry, tokens, cx),
		SettingsPage::Themes => themes::render_themes_page(state, controls, geometry, tokens, cx),
		SettingsPage::Keybindings => {
			keybindings::render_keybindings_page(state, controls, geometry, tokens)
		},
		SettingsPage::Providers => {
			providers::render_providers_page(state, controls, geometry, tokens, cx)
		},
		SettingsPage::Authentication => auth::render_auth_page(state, geometry, tokens, cx),
		SettingsPage::Mcp => mcp::render_mcp_page(state, controls, geometry, tokens, cx),
		SettingsPage::Extensions => extensions::render_extensions_page(state, geometry, tokens, cx),
		SettingsPage::Diagnostics => {
			diagnostics::render_diagnostics_page(state, controls, geometry, tokens, cx)
		},
		SettingsPage::Usage => usage::render_usage_page(state, controls, geometry, tokens, cx),
		SettingsPage::ContextBreakdown => {
			context::render_context_page(state, controls, geometry, tokens)
		},
	};

	// The body scrolls along one axis: a page longer than the overlay is
	// reached by scrolling, never by a second column.
	container = container.child(ScrollView::new(body_content).axis(Axis::Vertical));
	container
}
