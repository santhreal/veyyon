//! Extensions settings page body rendering (§5.9).

use veyyon_desktop_kit::{
	Avatar, AvatarSize, Badge, Button, ButtonSize, InteractiveState, Row, SpacingStep, TintRole,
	TokenSet,
};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style, hairline_for},
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
};

/// Renders the Extensions and subagents configuration page rows.
pub fn render_extensions_page(
	state: &SettingsState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let ext_error =
		hairline_for(controls, &SurfaceId::SettingsField("extensions".to_string()), tokens, cx);
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap))
		.children(ext_error);

	if state.extensions.is_empty() {
		return container.child(empty_state_row(
			"No extensions or subagents registered.",
			geometry,
			tokens,
		));
	}

	for agent in &state.extensions {
		let is_task = agent.kind == "task";
		let is_failed = agent.status == "error" || agent.status == "failed";
		let is_running_task = is_task && matches!(agent.status.as_str(), "active" | "running");
		let av = if is_failed {
			controls.availability(&SurfaceId::AgentReviveButton(agent.id.clone()))
		} else if is_running_task {
			controls.availability(&SurfaceId::TaskCancelButton(agent.id.clone()))
		} else {
			controls.availability(&SurfaceId::SettingsField("extensions".to_string()))
		};
		let tint = match agent.status.to_lowercase().as_str() {
			"active" | "running" | "ready" => TintRole::Done,
			"error" | "failed" => TintRole::Error,
			_ => TintRole::Plan,
		};
		let label = if agent.display_name.is_empty() {
			&agent.id
		} else {
			&agent.display_name
		};
		let desc = format!("Role: {} | Scope: {}", agent.kind, agent.scope);

		// The avatar shows the agent's initials, so a row is told apart from
		// its neighbours at a glance; the badge beside it states its status.
		let mut control = Row::new(SpacingStep::S2)
			.child(Avatar::new(initials(label)).size(AvatarSize::Small))
			.child(Badge::new(&agent.status, tint));
		let action = if is_failed {
			Some(("Revive", SurfaceId::AgentReviveButton(agent.id.clone())))
		} else if is_running_task {
			Some(("Cancel", SurfaceId::TaskCancelButton(agent.id.clone())))
		} else {
			None
		};
		if let Some((label, surface)) = action {
			let (_, _, allowed) = availability_style(&av, tokens);
			let mut button = Button::new(label).size(ButtonSize::Small);
			if allowed {
				let target = surface.clone();
				button = button.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryControl(target.clone()), cx);
				}));
			} else {
				button = button.state(InteractiveState::Disabled);
			}
			control = control.child(button);
			container = container.children(hairline_for(controls, &surface, tokens, cx));
		}
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
