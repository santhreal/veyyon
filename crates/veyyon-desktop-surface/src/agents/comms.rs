//! Agent dashboard comms stream view (§5).
//!
//! Renders the agent-to-agent IRC comms stream, oldest first,
//! with reply links and outcome/error indicators.

use veyyon_desktop_kit::{Badge, ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet};
use veyyon_desktop_model::AgentMessageOutcome;
use veyyon_desktop_tokens::AgentsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use super::AgentsState;
use crate::{cards::line_age, empty::empty_state};

/// What a line states about how it landed, beside who spoke. An ordinary
/// delivery states nothing: a badge on every row is a badge on none.
#[must_use]
pub const fn outcome_badge(outcome: AgentMessageOutcome) -> Option<(&'static str, TintRole)> {
	match outcome {
		AgentMessageOutcome::Injected => None,
		AgentMessageOutcome::Woken => Some(("woken", TintRole::Done)),
		AgentMessageOutcome::Revived => Some(("revived", TintRole::Done)),
		AgentMessageOutcome::Failed => Some(("failed", TintRole::Error)),
	}
}

/// Renders the comms stream view.
pub fn render_comms_view(
	state: &AgentsState,
	now_ms: u64,
	geometry: &AgentsSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	if state.agent_comms.is_empty() {
		return div()
			.flex_1()
			.w_full()
			.child(empty_state(
				"agents-comms-empty",
				"No agent has spoken",
				"Agents talk to each other while they work, and every line lands here",
				tokens,
			))
			.into_any_element();
	}

	let mut list = div()
		.id("agents-comms-list")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_y_scroll()
		.flex_1();

	for msg in &state.agent_comms {
		let age = line_age(now_ms, msg.at_ms);

		let mut meta = div()
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(age),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(format!("{} → {}", msg.from, msg.to)),
			);

		if let Some(reply_to) = &msg.reply_to {
			meta = meta.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("re: {reply_to}")),
			);
		}

		if let Some((word, tint)) = outcome_badge(msg.outcome) {
			meta = meta.child(Badge::new(word, tint));
		}

		let mut row = div()
			.id(ElementId::Name(format!("agent-msg-{}", msg.id).into()))
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S1))
			.p(tokens.spacing(SpacingStep::S3))
			.child(meta)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(msg.body.clone()),
			);

		if let Some(error) = &msg.error {
			row = row.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::ErrorInk))
					.child(format!("Error: {error}")),
			);
		}

		list = list.child(row);
	}

	list.into_any_element()
}
