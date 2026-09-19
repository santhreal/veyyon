//! Integrated model selection and turn submission in one composer row.

use veyyon_desktop_kit::{
	Badge, ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TintRole, TokenSet,
	Tooltip, controls::control_metrics,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, StatefulInteractiveElement, Styled, div,
};

use super::{ComposerState, TurnPhase, turn_action_controls};
use crate::{
	ShellView,
	controls::{ControlStates, availability_style},
	detail::{Detail, DetailKind},
};

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
		.map(|mode| Badge::new(mode.label().to_owned(), TintRole::Plan));

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
		.child(
			div()
				.flex()
				.min_w_0()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.children(mode)
				.child(Tooltip::new(availability.reason().unwrap_or(label).to_owned(), model).above())
				.children(thinking_control)
				.children(context_meter),
		)
		.child(turn_action_controls(turn, has_text, session_id, states, tokens, cx))
}
