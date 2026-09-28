//! The live roster: one row per agent, an agent inside a turn above one that
//! is not, with the controls the host answers for the agent's state.

use veyyon_desktop_model::{AgentState, AgentView, HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, DotStatus, StatusDot},
	theme::{Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, IntoElement, ParentElement, Styled, div, prelude::*,
};

use super::AgentsView;
use crate::panel::style::empty_state;

/// The roster in the order it draws: an agent inside a turn above one that
/// is not, and within each the order the host sent.
pub fn roster_order(agents: &[AgentView]) -> Vec<&AgentView> {
	let (mid_turn, rest): (Vec<_>, Vec<_>) =
		agents.iter().partition(|agent| agent.state().is_mid_turn());
	mid_turn.into_iter().chain(rest).collect()
}

/// Whether the roster offers to end this agent: one inside a turn that is
/// not the agent driving the session.
pub fn can_terminate(agent: &AgentView) -> bool {
	agent.kind != "main" && agent.state().is_mid_turn()
}

/// Whether the roster offers to revive this agent: its session was disposed
/// and its transcript is still on disk.
pub fn can_revive(agent: &AgentView) -> bool {
	agent.state() == AgentState::Parked
}

/// What the row calls the agent: its call sign, else the registry's label,
/// else its id.
pub fn row_name(agent: &AgentView) -> &str {
	[&agent.call_sign, &agent.display_name, &agent.id]
		.into_iter()
		.map(|candidate| candidate.trim())
		.find(|candidate| !candidate.is_empty())
		.unwrap_or_default()
}

/// The agent's role, and the type it was spawned from when that is not
/// already on the row.
pub fn row_kind(agent: &AgentView) -> String {
	let kind = agent.kind.trim();
	let spawned_from = agent.display_name.trim();
	let repeats = spawned_from.is_empty()
		|| spawned_from.eq_ignore_ascii_case(kind)
		|| spawned_from.eq_ignore_ascii_case(row_name(agent))
		|| spawned_from.eq_ignore_ascii_case(agent.id.trim());
	match (kind.is_empty(), repeats) {
		(true, true) => String::new(),
		(true, false) => spawned_from.to_owned(),
		(false, true) => kind.to_owned(),
		(false, false) => format!("{kind} \u{b7} {spawned_from}"),
	}
}

/// The dot an agent's state is drawn with.
const fn dot(state: AgentState) -> DotStatus {
	match state {
		AgentState::Running => DotStatus::Running,
		AgentState::Blocked | AgentState::Waiting => DotStatus::Waiting,
		AgentState::Aborted => DotStatus::Error,
		AgentState::Idle | AgentState::Parked | AgentState::Unknown => DotStatus::Idle,
	}
}

impl AgentsView {
	pub(super) fn render_roster(&self, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let app = self.app.read(cx);
		let agents = &app.store().domains.agents;
		if agents.is_empty() {
			return empty_state("No agent is running", None::<Div>, palette).into_any_element();
		}
		let revive_refused = app.panel_unavailable(HostActionKind::ReviveAgent);
		let cancel_refused = app.panel_unavailable(HostActionKind::CancelTask);
		let rows = roster_order(agents)
			.into_iter()
			.enumerate()
			.map(|(ix, agent)| {
				if self.confirming.as_deref() == Some(agent.id.as_str()) {
					return Self::confirm_row(ix, agent, palette, cx);
				}
				let mut controls = div().flex().flex_none().items_center().gap(space::S1);
				if let Some(session) = agent.session.clone() {
					let preview = session.clone();
					controls = controls
						.child(
							Button::new(("agent-preview", ix), "Preview")
								.size(ButtonSize::Sm)
								.variant(ButtonVariant::Ghost)
								.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
									this.preview(preview.clone(), cx);
								})),
						)
						.child(
							Button::new(("agent-open", ix), "Open")
								.size(ButtonSize::Sm)
								.variant(ButtonVariant::Ghost)
								.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
									let session = session.clone();
									this.app.update(cx, |app, cx| {
										app.open_session(session, cx);
									});
								})),
						);
				}
				if can_revive(agent) {
					let id = agent.id.clone();
					controls = controls.child(
						Button::new(("agent-revive", ix), "Revive")
							.size(ButtonSize::Sm)
							.disabled(revive_refused.is_some())
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								this.send(
									HostAction::ReviveAgent { agent_id: id.clone() },
									SurfaceId::AgentReviveButton(id.clone()),
									cx,
								);
							})),
					);
				}
				if can_terminate(agent) {
					let id = agent.id.clone();
					controls = controls.child(
						Button::new(("agent-end", ix), "End")
							.size(ButtonSize::Sm)
							.variant(ButtonVariant::Ghost)
							.disabled(cancel_refused.is_some())
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								this.confirming = Some(id.clone());
								cx.notify();
							})),
					);
				}
				agent_row(agent, palette).child(controls).into_any_element()
			});
		div()
			.id("agents-roster")
			.flex()
			.flex_col()
			.flex_1()
			.min_h_0()
			.overflow_y_scroll()
			.children(rows)
			.into_any_element()
	}

	fn confirm_row(
		ix: usize,
		agent: &AgentView,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let id = agent.id.clone();
		div()
			.flex()
			.items_center()
			.gap(space::S2)
			.px(space::S3)
			.py(space::S2)
			.bg(palette.bg.hover)
			.type_style(text::UI)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.text_color(palette.text.primary)
					.child(format!("End {}?", row_name(agent))),
			)
			.child(
				Button::new(("agent-end-cancel", ix), "Keep")
					.size(ButtonSize::Sm)
					.variant(ButtonVariant::Ghost)
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
						this.confirming = None;
						cx.notify();
					})),
			)
			.child(
				Button::new(("agent-end-confirm", ix), "End agent")
					.size(ButtonSize::Sm)
					.variant(ButtonVariant::Danger)
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
						this.confirming = None;
						this.send(
							HostAction::CancelTask { task_id: id.clone() },
							SurfaceId::TaskCancelButton(id.clone()),
							cx,
						);
					})),
			)
			.into_any_element()
	}
}

/// The row's dot, name, kind, state, model and gist, before its controls.
fn agent_row(agent: &AgentView, palette: &Palette) -> Div {
	let kind = row_kind(agent);
	let detail = [agent.model.as_deref(), agent.activity.as_deref()]
		.into_iter()
		.flatten()
		.collect::<Vec<_>>()
		.join(" \u{b7} ");
	div()
		.flex()
		.items_center()
		.gap(space::S2)
		.px(space::S3)
		.py(space::S1_5)
		.border_b_1()
		.border_color(palette.border.subtle)
		.child(StatusDot::new(dot(agent.state())))
		.child(
			div()
				.flex()
				.flex_col()
				.flex_1()
				.min_w_0()
				.child(
					div()
						.flex()
						.items_baseline()
						.gap(space::S1_5)
						.type_style(text::UI_MEDIUM)
						.child(
							div()
								.truncate()
								.text_color(palette.text.primary)
								.child(row_name(agent).to_owned()),
						)
						.when(!kind.is_empty(), |el| {
							el.child(
								div()
									.flex_none()
									.type_style(text::SMALL)
									.text_color(palette.text.muted)
									.child(kind),
							)
						})
						.child(
							div()
								.flex_none()
								.type_style(text::SMALL)
								.text_color(dot(agent.state()).color(palette))
								.child(agent.status.clone()),
						),
				)
				.when(!detail.is_empty(), |el| {
					el.child(
						div()
							.truncate()
							.type_style(text::SMALL)
							.text_color(palette.text.muted)
							.child(detail),
					)
				}),
		)
}
