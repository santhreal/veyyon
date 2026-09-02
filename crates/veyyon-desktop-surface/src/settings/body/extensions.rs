//! Extensions settings page body rendering (§5.9).

use veyyon_desktop_kit::{Badge, TintRole, TokenSet};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div};

use crate::{
	ShellView,
	controls::Availability,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
};

/// Renders the Extensions and subagents configuration page rows.
pub fn render_extensions_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	_cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	if state.extensions.is_empty() {
		return container.child(empty_state_row(
			"No extensions or subagents registered.",
			geometry,
			tokens,
		));
	}

	for agent in &state.extensions {
		let tint = match agent.status.to_lowercase().as_str() {
			"active" | "running" | "ready" => TintRole::Done,
			"error" | "failed" => TintRole::Error,
			_ => TintRole::Plan,
		};
		let chip = Badge::new(&agent.status, tint);
		let av = Availability::Enabled;

		let label = if agent.display_name.is_empty() {
			&agent.id
		} else {
			&agent.display_name
		};
		let desc = format!("Role: {} | Scope: {}", agent.kind, agent.scope);

		container = container.child(setting_row(label, Some(&desc), chip, &av, geometry, tokens));
	}

	container
}
