//! Selected-agent identity, activity, metrics, recent work, and lifecycle
//! actions.

use gpui::{App, Div, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AgentProgressView, AgentView, Capability, CapabilityStatus, CommandState},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Banner, Button, Card, Fill, Icon, Meter, Size, Tone, text},
};

use super::{chrome, format, logic};
use crate::act;

pub fn render(agent: &AgentView, store: &Store, cx: &mut App) -> Div {
	let connected = store.connection.is_connected();
	let commands_available = matches!(
		store.replica.capabilities.get(&Capability::AgentCommands),
		Some(CapabilityStatus::Available)
	);
	let command_state = store.command_state(&CommandTarget::Agent(agent.id.clone()));
	let pending = matches!(command_state, CommandState::Pending { .. });
	let enabled = connected && commands_available && !pending;
	let disabled_reason = if connected {
		"Agent commands are unavailable from this host"
	} else {
		"Reconnect to send agent commands"
	};
	let mut body = text::stack(space::LOOSE)
		.w_full()
		.child(identity(agent, cx))
		.child(activity(agent, cx));
	if let Some(banner) = command_banner(&command_state) {
		body = body.child(banner);
	}
	if let Some(progress) = &agent.progress {
		body = body.child(metrics(progress, cx));
		if let Some(failure) = &progress.failure {
			body = body.child(Banner::failure("Agent failed").detail(failure.clone()));
		}
		if let Some(retry) = &progress.retry {
			body = body.child(Banner::waiting("Agent retrying").detail(retry.clone()));
		}
		body = body.child(recent(progress, cx));
	}
	let kill_owner = super::state::control_owner(&agent.id, super::state::ControlSlot::Kill);
	let revive_owner = super::state::control_owner(&agent.id, super::state::ControlSlot::Revive);
	let can_kill = logic::can_kill(agent);
	let kill_enabled = enabled && can_kill;
	let mut kill_btn = Button::labelled(format!("kill-agent-{}", agent.id), kill_owner, "Kill")
		.icon(Icon::Stop)
		.size(Size::Base)
		.fill(Fill::Ghost)
		.tone(Tone::Danger)
		.tip("Stop this agent")
		.on_click(act::click(UiCommand::KillAgent(agent.id.clone())));
	if !kill_enabled {
		kill_btn = kill_btn.disabled(if !can_kill {
			"Agent is not running"
		} else {
			disabled_reason
		});
	}

	let can_revive = logic::can_revive(agent);
	let revive_enabled = enabled && can_revive;
	let mut revive_btn =
		Button::labelled(format!("revive-agent-{}", agent.id), revive_owner, "Revive")
			.icon(Icon::Return)
			.size(Size::Base)
			.fill(Fill::Tinted)
			.tone(Tone::Accent)
			.tip("Revive this agent")
			.on_click(act::click(UiCommand::ReviveAgent(agent.id.clone())));
	if !revive_enabled {
		revive_btn = revive_btn.disabled(if !can_revive {
			"Only parked agents can be revived"
		} else {
			disabled_reason
		});
	}

	body.child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::SNUG))
			.child(kill_btn)
			.child(revive_btn),
	)
}

fn identity(agent: &AgentView, cx: &mut App) -> Card {
	let theme = Theme::get(cx);
	let mut header = div()
		.flex()
		.items_start()
		.gap(px(space::BASE))
		.min_w(px(0.0))
		.child(
			div()
				.flex()
				.flex_col()
				.flex_1()
				.min_w(px(0.0))
				.child(
					text::line(agent.display_name.clone())
						.text_size(px(size::section()))
						.font_weight(weight::STRONG)
						.text_color(theme.text),
				)
				.child(
					text::line(logic::kind_label(agent.kind))
						.text_size(px(size::meta()))
						.text_color(theme.text_muted),
				),
		)
		.child(chrome::status_badge(
			logic::status_label(&agent.status),
			logic::status_tone(&agent.status),
			logic::status_icon(&agent.status),
		));
	if agent.waiting_on_peer.is_some() || agent.pending_approval.is_some() {
		header = header.child(chrome::status_badge("Blocked", Tone::Warn, Icon::Notice));
	}
	let mut card = Card::new().child(header);
	if let Some(model) = agent.model.as_ref() {
		card = card.child(chrome::labelled_icon(Icon::Engine, model.to_string(), cx));
	}
	if let Some(scope) = &agent.scope {
		card = card.child(chrome::labelled_icon(Icon::Checkout, scope.clone(), cx));
	}
	card
}

fn activity(agent: &AgentView, cx: &mut App) -> Card {
	let mut card = Card::new().child(chrome::section_heading("Current work", [], cx));
	if let Some(intent) = &agent.activity {
		card = card.child(chrome::labelled_icon(Icon::Notice, intent.clone(), cx));
	} else {
		card = card.child(chrome::labelled_icon(Icon::Notice, "No current intent reported", cx));
	}
	if let Some(progress) = &agent.progress {
		if let Some(tool) = progress.current_tool.as_ref() {
			card = card.child(chrome::labelled_icon(Icon::Tool, tool.to_string(), cx));
		}
		if let Some(model) = progress.resolved_model.as_ref() {
			card = card.child(chrome::labelled_icon(
				Icon::Engine,
				format!("Resolved model · {model}"),
				cx,
			));
		}
		if let Some(fallback) = progress.fallback_model.as_ref() {
			card =
				card.child(Banner::notice("Model fallback").detail(format!("Started from {fallback}")));
		}
	}
	if let Some(peer) = agent.waiting_on_peer.as_ref() {
		card = card.child(Banner::waiting("Waiting on another agent").detail(peer.to_string()));
	}
	if let Some(approval) = agent.pending_approval.as_ref() {
		card = card.child(Banner::waiting("Waiting for approval").detail(approval.to_string()));
	}
	card
}

fn metrics(progress: &AgentProgressView, cx: &mut App) -> Div {
	let mut metrics = div().flex().flex_wrap().gap(px(space::SNUG)).children([
		chrome::metric("Duration", format::elapsed_label(progress.duration_ms), cx)
			.into_any_element(),
		chrome::metric("Lifetime tokens", format::token_label(progress.lifetime_tokens), cx)
			.into_any_element(),
		chrome::metric("Cost", format::cost_label(progress.cost_microusd), cx).into_any_element(),
		chrome::metric("Requests", format::request_label(progress.requests.len() as u64), cx)
			.into_any_element(),
		chrome::metric("Recent tools", format::tool_label(progress.recent_tools.len() as u64), cx)
			.into_any_element(),
	]);
	if progress.current_context_tokens > 0 || progress.context_window.is_some() {
		let label = format::context_label(progress.current_context_tokens, progress.context_window);
		metrics = metrics.child(match progress.context_window {
			Some(window) if window > 0 => Card::new()
				.child(
					Meter::new(progress.current_context_tokens as f32 / window as f32)
						.what("Context")
						.figure(label),
				)
				.into_any_element(),
			_ => chrome::metric("Context", label, cx).into_any_element(),
		});
	}
	metrics
}

fn recent(progress: &AgentProgressView, cx: &mut App) -> Card {
	let mut card = Card::new().child(chrome::section_heading("Recent activity", [], cx));
	for tool in &progress.recent_tools {
		card = card.child(chrome::labelled_icon(Icon::Tool, tool.to_string(), cx));
	}
	for output in &progress.recent_output {
		card = card.child(chrome::labelled_icon(Icon::Engine, output.clone(), cx));
	}
	if progress.recent_tools.is_empty() && progress.recent_output.is_empty() {
		card = card.child(chrome::labelled_icon(Icon::Notice, "No recent activity reported", cx));
	}
	card
}

fn command_banner(state: &CommandState) -> Option<Banner> {
	match state {
		CommandState::Idle => None,
		CommandState::Pending { request } => {
			Some(Banner::waiting("Agent command pending").detail(format!("Request {}", request.get())))
		},
		CommandState::Failed { request, message } => Some(
			Banner::failure("Agent command failed")
				.detail(format!("Request {} · {message}", request.get())),
		),
	}
}
