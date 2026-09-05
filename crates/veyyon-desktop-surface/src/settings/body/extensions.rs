//! Extensions settings page body rendering (§5.9).

use veyyon_desktop_kit::{Avatar, AvatarSize, Badge, Row, SpacingStep, TintRole, TokenSet};
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
		let av = Availability::Enabled;

		let label = if agent.display_name.is_empty() {
			&agent.id
		} else {
			&agent.display_name
		};
		let desc = format!("Role: {} | Scope: {}", agent.kind, agent.scope);

		// The avatar shows the agent's initials, so a row is told apart from
		// its neighbours at a glance; the badge beside it states its status.
		let control = Row::new(SpacingStep::S2)
			.child(Avatar::new(initials(label)).size(AvatarSize::Small))
			.child(Badge::new(&agent.status, tint));

		container = container.child(setting_row(label, Some(&desc), control, &av, geometry, tokens));
	}

	container
}

/// The first letter of the first two words of `name`, upper-cased: `Code
/// Reviewer` is `CR`, `scout` is `S`.
fn initials(name: &str) -> String {
	name
		.split(|c: char| !c.is_alphanumeric())
		.filter(|word| !word.is_empty())
		.take(2)
		.filter_map(|word| word.chars().next())
		.flat_map(char::to_uppercase)
		.collect()
}
