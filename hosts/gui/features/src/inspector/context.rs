//! Usage, context, queue, stream, retry, and compaction inspection.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::model::{
	AgentView, ContextSnapshot, InterruptMode, QueueDelivery, SessionRuntimeView, SubmissionMode,
	TurnState, UsageSnapshot,
};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Banner, Card, Meter, Tone, text},
};

use super::chrome;
use crate::agents::format;

pub fn render(
	usage: &UsageSnapshot,
	context: &ContextSnapshot,
	runtime: Option<&SessionRuntimeView>,
	agent: Option<&AgentView>,
	cx: &mut App,
) -> Div {
	let mut body = text::stack(space::LOOSE)
		.w_full()
		.child(context_window(context, cx))
		.child(usage_totals(usage, cx));
	if let Some(runtime) = runtime {
		body = body.child(runtime_state(runtime, cx));
	}
	if let Some(agent) = agent {
		body = body.child(collaboration(agent, cx));
	}
	body
}

fn context_window(context: &ContextSnapshot, cx: &mut App) -> Card {
	let theme = Theme::get(cx);
	let current = &context.current;
	let mut card = Card::new().child(section_title("Context window", cx));
	card = match current.context_window {
		Some(window) if window > 0 => card.child(
			Meter::new(current.tokens as f32 / window as f32)
				.what("Current context")
				.figure(format::context_label(current.tokens, Some(window))),
		),
		_ => card.child(chrome::definition(
			"Current context",
			format::context_label(current.tokens, None),
			cx,
		)),
	};
	if context.estimated {
		card = card.child(
			text::line("Estimated from the latest available context snapshot")
				.text_size(px(size::meta()))
				.text_color(theme.text_faint),
		);
	}
	if let Some(error) = &context.error {
		card = card.child(Banner::failure("Context estimate unavailable").detail(error.clone()));
	}
	for category in &context.categories {
		card = card.child(chrome::definition(
			category.label.clone(),
			format::token_label(category.tokens),
			cx,
		));
	}
	card
}

fn usage_totals(usage: &UsageSnapshot, cx: &mut App) -> Card {
	let totals = &usage.session;
	let mut card = Card::new()
		.child(section_title("Session usage", cx))
		.child(chrome::definition("Input", format::token_label(totals.input_tokens), cx))
		.child(chrome::definition("Output", format::token_label(totals.output_tokens), cx))
		.child(chrome::definition("Cache read", format::token_label(totals.cache_read_tokens), cx))
		.child(chrome::definition("Cache write", format::token_label(totals.cache_write_tokens), cx))
		.child(chrome::definition(
			"Orchestration",
			format::token_label(totals.orchestration_tokens),
			cx,
		))
		.child(chrome::definition("Premium requests", totals.premium_requests.to_string(), cx))
		.child(chrome::definition("Cost", format::cost_label(totals.cost_microusd), cx));
	if !usage.pricing_known {
		card = card.child(Banner::notice("Provider pricing is unavailable"));
	}
	card
}

fn runtime_state(runtime: &SessionRuntimeView, cx: &mut App) -> Card {
	Card::new()
		.child(section_title("Runtime", cx))
		.child(chrome::definition(
			"Stream",
			if runtime.streaming {
				"Streaming"
			} else {
				"Idle"
			},
			cx,
		))
		.child(chrome::definition("Queue", format!("{} pending", runtime.queue.count), cx))
		.child(chrome::definition("Steering", queue_delivery(&runtime.queue.steering), cx))
		.child(chrome::definition("Follow-up", queue_delivery(&runtime.queue.follow_up), cx))
		.child(chrome::definition("Interrupt", interrupt_mode(&runtime.queue.interrupt), cx))
		.child(chrome::definition(
			"Active submission",
			submission_mode(runtime.queue.active_submission),
			cx,
		))
		.child(chrome::definition(
			"Auto-compaction",
			if runtime.auto_compaction { "On" } else { "Off" },
			cx,
		))
		.child(turn(&runtime.turn, cx))
}

fn collaboration(agent: &AgentView, cx: &mut App) -> Card {
	let mut card = Card::new()
		.child(section_title("Participants", cx))
		.child(chrome::definition(
			"Access",
			if agent.transcript_read_only {
				"Read-only"
			} else {
				"Interactive"
			},
			cx,
		));
	if agent.participants.is_empty() {
		return card.child(chrome::definition("Participants", "None reported", cx));
	}
	for participant in &agent.participants {
		card = card.child(chrome::definition("Agent", participant.to_string(), cx));
	}
	card
}

fn turn(state: &TurnState, cx: &mut App) -> Div {
	let (label, value, tone) = match state {
		TurnState::Idle => ("Turn", "Idle".to_owned(), Tone::Muted),
		TurnState::Running { phase, .. } => ("Turn", format!("{phase:?}"), Tone::Accent),
		TurnState::Aborting => ("Turn", "Aborting".to_owned(), Tone::Warn),
		TurnState::Retrying { attempt, max, error, mode, .. } => {
			("Retry", format!("{mode}: attempt {attempt} of {max} · {error}"), Tone::Warn)
		},
		TurnState::Compacting { reason, action } => {
			("Compaction", format!("{action} · {reason}"), Tone::Accent)
		},
	};
	div()
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.child(chrome::state(label, tone))
		.child(text::note_wrapping(value, &Theme::get(cx)).min_w(px(0.0)))
}

fn queue_delivery(mode: &QueueDelivery) -> String {
	match mode {
		QueueDelivery::Immediate => "Immediate".to_owned(),
		QueueDelivery::Queued => "Queued".to_owned(),
		QueueDelivery::Disabled => "Disabled".to_owned(),
		QueueDelivery::Unknown(value) => value.clone(),
	}
}

fn interrupt_mode(mode: &InterruptMode) -> String {
	match mode {
		InterruptMode::AbortThenSend => "Abort, then send".to_owned(),
		InterruptMode::Queue => "Queue".to_owned(),
		InterruptMode::Disabled => "Disabled".to_owned(),
		InterruptMode::Unknown(value) => value.clone(),
	}
}

fn submission_mode(mode: SubmissionMode) -> &'static str {
	match mode {
		SubmissionMode::Prompt => "Prompt",
		SubmissionMode::Steer => "Steer",
		SubmissionMode::FollowUp => "Follow-up",
	}
}

fn section_title(label: &'static str, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	text::line(label)
		.text_size(px(size::meta()))
		.font_weight(weight::MEDIUM)
		.text_color(theme.text)
}
