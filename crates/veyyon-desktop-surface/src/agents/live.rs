//! Agent dashboard live roster view (§5).
//!
//! Renders the live roster sorted so running agents appear above parked ones,
//! with open-session controls and termination confirmation.

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, ButtonVariant, ColorRole, InteractiveState, SpacingStep, TextRamp,
	TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_model::{AgentState, AgentView, SurfaceId};
use veyyon_desktop_tokens::AgentsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use super::AgentsState;
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
	empty::empty_state,
};

/// The tint a status badge paints with, over the states the host names
/// (§6.10).
///
/// Each state carries the tint the design system already owns for what it
/// means: an agent stopped at an approval takes the approval tint, one
/// stopped on a peer that may never answer takes the tint of something owed,
/// and a parked one is drawn as the neutral it is rather than as work in
/// progress. The match is exhaustive over the state, so a state added to the
/// protocol stops this build until it is given a meaning.
#[must_use]
pub fn status_tint(status: &str) -> TintRole {
	match AgentState::from(status) {
		AgentState::Running => TintRole::Working,
		AgentState::Blocked => TintRole::Approve,
		AgentState::Idle => TintRole::Done,
		AgentState::Waiting => TintRole::Due,
		AgentState::Aborted => TintRole::Error,
		AgentState::Parked | AgentState::Unknown => TintRole::Plan,
	}
}

/// The roster in the order it draws: an agent inside a turn above one that is
/// not, and within each of those the order the host sent.
///
/// An agent stopped at an approval prompt is inside a turn, and is the row an
/// operator most needs to reach.
#[must_use]
pub fn roster_order(agents: &[AgentView]) -> Vec<AgentView> {
	let mut ordered = agents.to_vec();
	ordered.sort_by_key(|agent| !agent.state().is_mid_turn());
	ordered
}

/// Whether the roster offers to open this agent's own session. An agent that
/// holds none has nothing to open.
#[must_use]
pub const fn can_open(agent: &AgentView) -> bool {
	agent.session.is_some()
}

/// Whether the roster offers to end this agent.
///
/// `CancelTask` ends any agent the registry holds, so the control is drawn on
/// one that is still in a turn and is not the agent driving the session:
/// ending that one ends the conversation the card is open over. The rule used
/// to read `kind == "task"`, a kind no host sends -- the roster carries the
/// registry's own kinds, `main`, `sub` and `advisor` -- so the control was
/// drawn on nothing and no agent could be ended from the window at all.
#[must_use]
pub fn can_terminate(agent: &AgentView) -> bool {
	agent.kind != "main" && agent.state().is_mid_turn()
}

/// Whether the roster offers to revive this agent.
///
/// A parked agent is one whose session was disposed and whose transcript is
/// still on disk, which is the one state the host can bring back. The rule
/// used to read `error` or `failed`, neither of which is a word any host
/// sends, so the control was drawn on nothing; had it matched, it would have
/// been drawn on `aborted`, the one state a revive always refuses.
#[must_use]
pub fn can_revive(agent: &AgentView) -> bool {
	agent.state() == AgentState::Parked
}

/// What the row calls this agent.
///
/// The call sign is the name a person reads and says, and the terminal
/// dashboard prints the same one, so an agent is called one thing wherever it
/// is listed. A host that sends none leaves the row on whatever it did send.
#[must_use]
pub fn row_name(agent: &AgentView) -> &str {
	[&agent.call_sign, &agent.display_name, &agent.id]
		.into_iter()
		.map(|candidate| candidate.trim())
		.find(|candidate| !candidate.is_empty())
		.unwrap_or_default()
}

/// What the row states beside the name: the agent's role, and the type it was
/// spawned from when that is not already on the row.
///
/// The type used to BE the label, so a fan-out of one agent type drew several
/// rows reading `deep (sub)` that no control could tell apart.
#[must_use]
pub fn row_kind(agent: &AgentView) -> String {
	let kind = agent.kind.trim();
	let spawned_from = agent.display_name.trim();
	let repeats = spawned_from.is_empty()
		|| spawned_from.eq_ignore_ascii_case(kind)
		|| spawned_from.eq_ignore_ascii_case(row_name(agent))
		|| spawned_from.eq_ignore_ascii_case(agent.id.trim());
	match (kind.is_empty(), repeats) {
		(true, true) => String::new(),
		(true, false) => format!("({spawned_from})"),
		(false, true) => format!("({kind})"),
		(false, false) => format!("({kind} · {spawned_from})"),
	}
}

/// Renders the live roster view.
pub fn render_live_view(
	state: &AgentsState,
	controls: &ControlStates,
	geometry: &AgentsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	if state.agents.is_empty() {
		return div()
			.flex_1()
			.w_full()
			.child(empty_state(
				"agents-live-empty",
				"No agent is running in this session",
				"Ask for work that spawns one, and it appears here the moment it starts",
				tokens,
			))
			.into_any_element();
	}

	let ordered = roster_order(&state.agents);

	let mut list = div()
		.id("agents-live-list")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_y_scroll()
		.flex_1();

	for agent in &ordered {
		let label = row_name(agent);
		let kind = row_kind(agent);

		if state.pending_termination.as_deref() == Some(&agent.id) {
			let confirm_id = agent.id.clone();
			let row = div()
				.id(ElementId::Name(format!("agent-confirm-{}", agent.id).into()))
				.h(px(geometry.row_height_px))
				.flex()
				.items_center()
				.justify_between()
				.px(tokens.spacing(SpacingStep::S4))
				.child(
					div()
						.text_color(tokens.color(ColorRole::Foreground))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.child(format!("Terminate agent {label}?")),
				)
				.child(
					div()
						.flex()
						.items_center()
						.gap(tokens.spacing(SpacingStep::S2))
						.child(
							Button::new(
								ElementId::Name(format!("cancel-term-{}", agent.id).into()),
								"Cancel",
							)
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(|view, _, _, cx| {
								view.dispatch(Intent::ConfirmTermination(None), cx);
							})),
						)
						.child(
							Button::new(
								ElementId::Name(format!("confirm-term-{}", agent.id).into()),
								"Terminate",
							)
							.size(ButtonSize::Small)
							.variant(ButtonVariant::Danger)
							.on_click(cx.listener(move |view, _, _, cx| {
								view.dispatch(Intent::ConfirmTermination(None), cx);
								view.dispatch(
									Intent::RetryControl(SurfaceId::TaskCancelButton(confirm_id.clone())),
									cx,
								);
							})),
						),
				);
			list = list.child(row);
			continue;
		}

		let tint = status_tint(&agent.status);

		let mut info = div()
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(label.to_owned()),
			);

		// The type is stated beside the name, not after the status badge: the
		// name and what it is are read as one phrase.
		if !kind.is_empty() {
			info = info.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(kind),
			);
		}
		info = info.child(Badge::new(&agent.status, tint));

		// The model is not a status, and a second badge beside the status badge reads
		// as one. The transcript footer names a model in muted small text; the roster
		// names it the same way.
		if let Some(model) = &agent.model {
			info = info.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(model.clone()),
			);
		}

		if let Some(activity) = &agent.activity {
			info = info.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("· {activity}")),
			);
		}

		let mut controls_row = div()
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2));

		if let Some(session_id) = agent.session.as_ref().filter(|_| can_open(agent)) {
			let sid = session_id.clone();
			controls_row = controls_row.child(
				Button::new(ElementId::Name(format!("agent-open-{}", agent.id).into()), "Open")
					.size(ButtonSize::Small)
					.variant(ButtonVariant::Ghost)
					.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
						view.dispatch(Intent::OpenSession(sid.clone()), cx);
					})),
			);
		}

		// A parked agent holds no session, so Open is not drawn on it and the row
		// carried no control at all: the transcript was on disk and nothing on
		// this surface reached it. Revive is what brings it back, and the host
		// answers it for exactly this state.
		if can_revive(agent) {
			let surface = SurfaceId::AgentReviveButton(agent.id.clone());
			let (_, _, allowed) = availability_style(&controls.availability(&surface), tokens);
			let mut revive_btn =
				Button::new(ElementId::Name(format!("agent-revive-{}", agent.id).into()), "Revive")
					.size(ButtonSize::Small)
					.variant(ButtonVariant::Ghost);
			if allowed {
				revive_btn = revive_btn.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryControl(surface.clone()), cx);
				}));
			} else {
				revive_btn = revive_btn.state(InteractiveState::Disabled);
			}
			controls_row = controls_row.child(revive_btn);
		}

		if can_terminate(agent) {
			let aid = agent.id.clone();
			let av = controls.availability(&SurfaceId::TaskCancelButton(agent.id.clone()));
			let (_, _, allowed) = availability_style(&av, tokens);
			let mut term_btn = Button::new(
				ElementId::Name(format!("agent-terminate-{}", agent.id).into()),
				"Terminate",
			)
			.size(ButtonSize::Small)
			.variant(ButtonVariant::Danger);
			if allowed {
				term_btn = term_btn.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::ConfirmTermination(Some(aid.clone())), cx);
				}));
			} else {
				term_btn = term_btn.state(InteractiveState::Disabled);
			}
			controls_row = controls_row.child(term_btn);
		}

		let row = div()
			.id(ElementId::Name(format!("agent-row-{}", agent.id).into()))
			.h(px(geometry.row_height_px))
			.flex()
			.items_center()
			.justify_between()
			.px(tokens.spacing(SpacingStep::S4))
			.hover(|style| style.bg(tokens.row_hover()))
			.child(info)
			.child(controls_row);

		list = list.child(row);
	}

	list.into_any_element()
}
