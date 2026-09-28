//! The traffic between agents, oldest first and pinned to the newest line:
//! who spoke to whom, what it answers, how it landed and why it failed.

use veyyon_desktop_model::{AgentMessageOutcome, AgentMessageView, AgentView};
use veyyon_desktop_ui::theme::{ActiveTheme, Palette, TypeStyled, space, text};
use veyyon_gpui::{
	AnyElement, Context, Div, Hsla, IntoElement, ParentElement, Styled, Window, div, list,
	prelude::*,
};

use super::{AgentsView, row_name};
use crate::panel::style::{empty_state, now_ms, span};

/// What a line states about how it landed. An ordinary delivery states
/// nothing: a mark on every row is a mark on none.
pub const fn outcome_mark(
	outcome: AgentMessageOutcome,
	palette: &Palette,
) -> Option<(&'static str, Hsla)> {
	match outcome {
		AgentMessageOutcome::Injected => None,
		AgentMessageOutcome::Woken => Some(("woke it", palette.status.success)),
		AgentMessageOutcome::Revived => Some(("revived it", palette.status.success)),
		AgentMessageOutcome::Failed => Some(("failed", palette.status.error)),
	}
}

/// How long ago `at_ms` was, as the row states it.
pub fn age(now: u64, at_ms: u64) -> String {
	let elapsed = now.saturating_sub(at_ms);
	if elapsed < 60_000 {
		"now".to_owned()
	} else {
		format!("{} ago", span(elapsed))
	}
}

/// The call sign of the agent `id` names, or `id` itself when the roster
/// holds no such agent.
fn speaker<'a>(agents: &'a [AgentView], id: &'a str) -> &'a str {
	agents
		.iter()
		.find(|agent| agent.id == id)
		.map_or(id, row_name)
}

impl AgentsView {
	/// Brings the comms list to the stream's length: appended lines are
	/// measured on their own, a stream that changed otherwise is measured
	/// again from the start.
	pub(super) fn sync_comms(&mut self, cx: &Context<Self>) {
		let comms = &self.app.read(cx).store().domains.agent_comms;
		let head = comms.first().map(|message| message.id.clone());
		let known = self.comms.item_count();
		if head == self.comms_head && comms.len() >= known {
			self.comms.splice(known..known, comms.len() - known);
		} else {
			self.comms.reset(comms.len());
		}
		self.comms_head = head;
	}

	pub(super) fn render_comms(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		if self.app.read(cx).store().domains.agent_comms.is_empty() {
			return empty_state("No agent has messaged another", None::<Div>, palette)
				.into_any_element();
		}
		list(
			self.comms.clone(),
			cx.processor(|this, ix: usize, _: &mut Window, cx| {
				let palette = cx.theme().palette;
				let domains = &this.app.read(cx).store().domains;
				domains.agent_comms.get(ix).map_or_else(
					|| div().into_any_element(),
					|message| comms_row(message, &domains.agents, now_ms(), &palette).into_any_element(),
				)
			}),
		)
		.flex_1()
		.min_h_0()
		.into_any_element()
	}
}

/// One line of traffic: its age, speaker and addressee, the line it answers
/// and how it landed over the body and any failure.
fn comms_row(message: &AgentMessageView, agents: &[AgentView], now: u64, palette: &Palette) -> Div {
	let meta = div()
		.flex()
		.items_baseline()
		.gap(space::S2)
		.child(
			div()
				.flex_none()
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(age(now, message.at_ms)),
		)
		.child(
			div()
				.min_w_0()
				.truncate()
				.type_style(text::UI_MEDIUM)
				.text_color(palette.text.primary)
				.child(format!(
					"{} \u{2192} {}",
					speaker(agents, &message.from),
					speaker(agents, &message.to)
				)),
		)
		.when_some(message.reply_to.as_ref(), |el, reply_to| {
			el.child(
				div()
					.flex_none()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(format!("re {reply_to}")),
			)
		})
		.when_some(outcome_mark(message.outcome, palette), |el, (word, color)| {
			el.child(
				div()
					.flex_none()
					.type_style(text::MICRO)
					.text_color(color)
					.child(word),
			)
		});
	div()
		.flex()
		.flex_col()
		.gap(space::S1)
		.px(space::S3)
		.py(space::S2)
		.border_b_1()
		.border_color(palette.border.subtle)
		.child(meta)
		.child(
			div()
				.type_style(text::UI)
				.text_color(palette.text.secondary)
				.child(message.body.clone()),
		)
		.when_some(message.error.as_ref(), |el, error| {
			el.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.status.error)
					.child(error.clone()),
			)
		})
}
