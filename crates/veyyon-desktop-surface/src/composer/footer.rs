//! Integrated model selection and turn submission in one composer row.

use veyyon_desktop_kit::{
	Badge, ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TintRole, TokenSet,
	Tooltip, controls::control_metrics,
};
use veyyon_desktop_model::{SessionId, SessionMode, SettableMode, SurfaceId};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, StatefulInteractiveElement, Styled, div,
};

use super::{ComposerState, TurnPhase, turn_action_controls};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
	detail::{Detail, DetailKind},
};

/// The mode chip, which in plan mode is also the control that re-opens the
/// plan.
///
/// The plan is read again from the file the agent wrote rather than from a
/// turn, so a session in plan mode can be asked for it at any point -- except
/// while its card is already up, where the card is the review and a second
/// one would answer the same plan twice.
fn mode_chip(
	turn: &TurnPhase,
	mode: &SessionMode,
	goal: Option<&veyyon_desktop_model::GoalView>,
	session: &SessionId,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	if matches!(mode, SessionMode::Goal) || goal.is_some() {
		let availability = states.availability(&SurfaceId::ComposerGoalChip(session.clone()));
		let (opacity, cursor, allowed) = availability_style(&availability, tokens);
		let (base_label, tint) = if let Some(goal) = goal {
			(goal.chip_text(), crate::cards::status_tint(goal.status))
		} else {
			(mode.label().to_owned(), TintRole::Working)
		};
		let label = availability.reason().unwrap_or(&base_label).to_owned();
		let badge = Badge::new(label.clone(), tint);
		let mut chip = div()
			.id("composer-footer-goal-chip")
			.aria_label(label.clone())
			.flex()
			.items_center()
			.opacity(opacity)
			.cursor(cursor);
		if allowed {
			chip = chip.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.dispatch(Intent::ToggleGoalCard, cx);
			}));
		}
		chip = chip.child(badge);
		return Tooltip::new(label, chip).above().into_any_element();
	}
	let badge = Badge::new(mode.label().to_owned(), TintRole::Plan);
	if matches!(mode, SessionMode::Loop) {
		let label = "Stop loop mode";
		let mut chip = div()
			.id("composer-footer-loop-stop")
			.aria_label(label)
			.flex()
			.items_center()
			.cursor(veyyon_gpui::CursorStyle::PointingHand)
			.child(badge);
		chip = chip.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
			view.dispatch(Intent::SetSessionMode { mode: SettableMode::None }, cx);
		}));
		return Tooltip::new(label.to_owned(), chip)
			.above()
			.into_any_element();
	}
	if !matches!(mode, SessionMode::Plan) || matches!(turn, TurnPhase::PlanPending { .. }) {
		return badge.into_any_element();
	}
	let availability = states.availability(&SurfaceId::SessionPlanReviewButton(session.clone()));
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let label = availability
		.reason()
		.unwrap_or("Review the plan")
		.to_owned();
	let mut chip = div()
		.id("composer-footer-plan-review")
		.aria_label(label.clone())
		.flex()
		.items_center()
		.opacity(opacity)
		.cursor(cursor)
		.child(badge);
	if allowed {
		chip = chip.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
			view.dispatch(Intent::ReviewPlan, cx);
		}));
	}
	Tooltip::new(label, chip).above().into_any_element()
}

/// The active model stays visible at every width, including before a catalogue
/// arrives.
#[must_use]
pub fn footer_row(
	turn: &TurnPhase,
	composer: &ComposerState,
	has_text: bool,
	session_id: u64,
	_labels: bool,
	states: &ControlStates,
	_geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let session = SessionId::from(session_id.to_string());
	let availability = states.availability(&SurfaceId::ComposerModelSelector(session.clone()));
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let label = composer
		.model
		.as_ref()
		.and_then(super::ModelControl::label)
		.unwrap_or("Select model");
	let mut model = div()
		.id("composer-footer-model")
		.aria_label(format!("Select model: {label}"))
		.h(metrics.height)
		.min_w_0()
		.px(tokens.spacing(SpacingStep::S2))
		.rounded(metrics.radius)
		.flex()
		.items_center()
		.gap(metrics.gap)
		.opacity(opacity)
		.cursor(cursor);
	// The label is truncated at a narrow width, never shed: §5.7 keeps a model
	// name on the footer at every width down to the 800px floor, and a control
	// that drew only a chevron is a 12px target with nothing in it to read.
	// The chevron is drawn beside it whatever the host offers, so an
	// unavailable selector is still a control with a reason on it (§4.3).
	model = model
		.child(
			div()
				.min_w_0()
				.truncate()
				.text_size(tokens.font_size(metrics.ramp))
				.line_height(tokens.line_height(metrics.ramp))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(label.to_owned()),
		)
		.child(Icon::new(IconName::ChevronDown).size(IconSize::Size12));
	if allowed {
		let hover = tokens.row_hover();
		model = model
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _: &ClickEvent, window, cx| {
				view.open_model_picker(window, cx);
			}));
	}
	// The chip draws a display name and nothing the catalog said about the
	// model behind it. A secondary press states the rest, above the chip,
	// because the chip sits on the window's bottom row (§8.25).
	let model = model.on_mouse_down(
		MouseButton::Right,
		cx.listener(|view, event: &MouseDownEvent, window, cx| {
			view.toggle_detail(Detail::above(DetailKind::Model, event.position), window, cx);
			cx.notify();
		}),
	);
	// The kit's chip, not a div of its own: a mode is a status the queue rows
	// and the settings pages already state this way.
	let mode = composer
		.mode
		.as_ref()
		.map(|mode| mode_chip(turn, mode, composer.goal.as_ref(), &session, states, tokens, cx))
		.or_else(|| {
			composer.goal.as_ref().map(|goal| {
				mode_chip(turn, &SessionMode::Goal, Some(goal), &session, states, tokens, cx)
			})
		});

	let thinking_control = composer.thinking.as_ref().map(|thinking| {
		let id = SurfaceId::ComposerThinkingSelector(session.clone());
		let avail = states.availability(&id);
		let (t_opacity, t_cursor, t_allowed) = availability_style(&avail, tokens);
		let t_label = format!("Thinking: {}", thinking.level);
		let mut btn = div()
			.id("composer-footer-thinking")
			.aria_label(t_label.clone())
			.h(metrics.height)
			.min_w_0()
			.px(tokens.spacing(SpacingStep::S2))
			.rounded(metrics.radius)
			.flex()
			.items_center()
			.gap(metrics.gap)
			.opacity(t_opacity)
			.cursor(t_cursor);
		btn = btn
			.child(
				div()
					.min_w_0()
					.truncate()
					.text_size(tokens.font_size(metrics.ramp))
					.line_height(tokens.line_height(metrics.ramp))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(format!("Thinking: {}", thinking.level)),
			)
			.child(Icon::new(IconName::ChevronDown).size(IconSize::Size12));
		if t_allowed {
			let hover = tokens.row_hover();
			btn = btn
				.hover(move |style| style.bg(hover))
				.on_click(cx.listener(|view, _: &ClickEvent, window, cx| {
					view.open_thinking_picker(window, cx);
				}));
		}
		Tooltip::new(avail.reason().unwrap_or(&t_label).to_owned(), btn).above()
	});

	let context_meter = composer.context.as_ref().map(|meter| {
		let label = match meter.limit_tokens {
			Some(limit) => format!(
				"{} / {}",
				super::state::thousands(meter.used_tokens),
				super::state::thousands(limit)
			),
			None => super::state::thousands(meter.used_tokens),
		};
		div()
			.id("composer-footer-context")
			.min_w_0()
			.truncate()
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp))
			.text_color(tokens.color(ColorRole::Muted))
			.child(label)
	});

	div()
		.id("composer-footer")
		.w_full()
		.flex()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S3))
		// The leading control carries `s2` of its own, and the draft above it
		// starts at the composer's padding. The row sheds that much on the
		// leading side, so the model name and the first line of the draft
		// start on one edge and the control's hover ground stays inside the
		// composer.
		.child(
			div()
				.flex()
				.min_w_0()
				.items_center()
				.ml(-tokens.spacing(SpacingStep::S2))
				.gap(tokens.spacing(SpacingStep::S2))
				.children(mode)
				.child(Tooltip::new(availability.reason().unwrap_or(label).to_owned(), model).above())
				.children(thinking_control)
				.children(context_meter),
		)
		.child(turn_action_controls(turn, has_text, session_id, states, tokens, cx))
}
