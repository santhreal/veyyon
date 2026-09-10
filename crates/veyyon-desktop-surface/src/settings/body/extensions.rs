//! Extensions settings page body rendering (§5.9).

use veyyon_desktop_kit::{
	Avatar, AvatarSize, Badge, Button, ButtonSize, InteractiveState, Row, SpacingStep, TextField,
	TintRole, TokenSet,
};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ElementId, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style, hairline_for},
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
	shell::fields::FieldSlots,
};

/// Renders the Extensions and subagents configuration page rows.
pub fn render_extensions_page(
	state: &SettingsState,
	fields: &FieldSlots,
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

	// The page spawns a task as well as listing what is running: the field
	// is the task, and it stays whether or not anything is running yet.
	if let Some(editor) = fields.task.clone() {
		let surface = SurfaceId::TaskSpawnButton;
		let av = controls.availability(&surface);
		let (_, _, allowed) = availability_style(&av, tokens);
		let mut run = Button::new("extensions-run-task", "Run").size(ButtonSize::Small);
		if allowed {
			run = run.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
				view.submit_task_prompt(cx);
			}));
		} else {
			run = run.state(InteractiveState::Disabled);
		}
		let control = Row::new(SpacingStep::S2)
			.child(TextField::new("task-prompt", editor))
			.child(run);
		container = container
			.children(hairline_for(controls, &surface, tokens, cx))
			.child(setting_row(
				"Background task",
				Some("Runs as a subagent of the active session"),
				control,
				&av,
				geometry,
				tokens,
			));
	}

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
			let mut button =
				Button::new(ElementId::Name(format!("agent-action-{}", agent.id).into()), label)
					.size(ButtonSize::Small);
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
