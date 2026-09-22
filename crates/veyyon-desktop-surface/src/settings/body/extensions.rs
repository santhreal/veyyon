//! Extensions settings page body rendering (§5.9).

use veyyon_desktop_kit::{
	Avatar, AvatarSize, Badge, Button, ButtonSize, InteractiveState, Row, SpacingStep, TextField,
	TokenSet,
};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ElementId, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	agents::live::{can_revive, can_terminate, row_kind, row_name, status_tint},
	controls::{ControlStates, availability_style},
	settings::{
		SettingsState, empty,
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
	// The sheet states the refusal of any control it draws -- this page's
	// `Run`, `Revive` and `Cancel` included -- in one row above the page
	// (§4.4).
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

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
		container = container.child(setting_row(
			"Background task",
			Some("Runs as a subagent of the active session"),
			control,
			&av,
			geometry,
			tokens,
		));
	}

	if state.extensions.is_empty() {
		return container.h_full().child(empty_state_row(
			empty::EXTENSIONS.condition,
			empty::EXTENSIONS.action,
			geometry,
			tokens,
		));
	}

	for agent in &state.extensions {
		// The page draws the roster's own rows, so an agent is named, described
		// and tinted the same here as on the dashboard, and a control appears
		// here only where the dashboard would offer it.
		let revivable = can_revive(agent);
		let endable = can_terminate(agent);
		let av = if revivable {
			controls.availability(&SurfaceId::AgentReviveButton(agent.id.clone()))
		} else if endable {
			controls.availability(&SurfaceId::TaskCancelButton(agent.id.clone()))
		} else {
			controls.availability(&SurfaceId::SettingsField("extensions".to_string()))
		};
		let label = row_name(agent);
		let desc = format!("{} | Scope: {}", row_kind(agent), agent.scope);

		// The avatar shows the agent's initials, so a row is told apart from
		// its neighbours at a glance; the badge beside it states its status.
		let mut control = Row::new(SpacingStep::S2)
			.child(Avatar::new(initials(label)).size(AvatarSize::Small))
			.child(Badge::new(&agent.status, status_tint(&agent.status)));
		let action = if revivable {
			Some(("Revive", SurfaceId::AgentReviveButton(agent.id.clone())))
		} else if endable {
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
				button = button.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryControl(surface.clone()), cx);
				}));
			} else {
				button = button.state(InteractiveState::Disabled);
			}
			control = control.child(button);
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
