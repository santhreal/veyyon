//! The composer's footer: model, thinking level, queue mode, attachments and
//! the context meter, beside the turn action (§5.4).
//!
//! Five controls, hard cap, in that order, each a quiet text control (§6.9):
//! no ground, no edge, secondary ink, a hairline wash on hover. Below the
//! compact threshold the labels shed to icons in one step (§5.7). A control
//! whose value the host has not reported is not drawn, and one the host has no
//! capability for is a label rather than a disabled control (§5.13).

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet,
	controls::control_metrics,
};
use veyyon_desktop_model::{QueueMode, SessionId, SurfaceId};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, CursorStyle, Div, ElementId, InteractiveElement, IntoElement,
	ParentElement, Stateful, StatefulInteractiveElement, Styled, div,
};

use super::{
	actions::turn_action_controls,
	state::ComposerState,
	turn::{ThinkingLevel, TurnPhase},
};
use crate::{
	Intent, ShellView,
	controls::{Availability, ControlStates, availability_style},
	overlay::Overlay,
	palette::PaletteState,
};

/// What activating a footer control does.
enum FooterAction {
	/// The control is a label: it states a value the operator cannot change
	/// here.
	Label,
	/// One click dispatches one intent. Boxed: an `Intent` is half a kilobyte
	/// and a label carries nothing, so the payload rides on the heap.
	Dispatch(Box<Intent>),
	/// The control opens the platform's file prompt.
	PickFiles,
}

/// One footer control, resolved from the composer state.
struct FooterControl {
	id:      &'static str,
	/// The request the control initiates, for its gate; `None` for a control
	/// that asks the host nothing (§4.3).
	surface: Option<SurfaceId>,
	icon:    IconName,
	label:   String,
	action:  FooterAction,
}

/// The controls the footer draws for `composer`, in §5.4 order.
fn footer_controls(composer: &ComposerState, session: &SessionId) -> Vec<FooterControl> {
	let mut controls = Vec::with_capacity(5);

	if let Some(model) = &composer.model
		&& let Some(label) = model.label()
	{
		let action = if model.selectable && !model.options.is_empty() {
			FooterAction::Dispatch(Box::new(Intent::OpenOverlay(Box::new(Overlay::Palette(
				PaletteState::from_models(model),
			)))))
		} else {
			FooterAction::Label
		};
		controls.push(FooterControl {
			id: "composer-footer-model",
			surface: Some(SurfaceId::ComposerModelSelector(session.clone())),
			icon: IconName::Cpu,
			label: label.to_owned(),
			action,
		});
	}

	if let Some(thinking) = &composer.thinking {
		let action = thinking.next().map_or(FooterAction::Label, |next| {
			FooterAction::Dispatch(Box::new(Intent::SetThinking(ThinkingLevel::new(next))))
		});
		controls.push(FooterControl {
			id: "composer-footer-thinking",
			surface: Some(SurfaceId::ComposerThinkingSelector(session.clone())),
			icon: IconName::Sparkles,
			label: thinking.level.clone(),
			action,
		});
	}

	let (mode_icon, mode_label, other) = match composer.queue_mode {
		QueueMode::Steer => (IconName::Zap, "Steer", QueueMode::Queue),
		QueueMode::Queue => (IconName::Layers, "Queue", QueueMode::Steer),
	};
	controls.push(FooterControl {
		id:      "composer-footer-mode",
		surface: Some(SurfaceId::ComposerQueueModeToggle(session.clone())),
		icon:    mode_icon,
		label:   mode_label.to_owned(),
		action:  FooterAction::Dispatch(Box::new(Intent::SetQueueMode(other))),
	});

	let count = composer.attachments.len();
	controls.push(FooterControl {
		id:      "composer-footer-attachments",
		surface: None,
		icon:    IconName::Paperclip,
		label:   match count {
			0 => "Attach".to_owned(),
			1 => "1 file".to_owned(),
			n => format!("{n} files"),
		},
		action:  FooterAction::PickFiles,
	});

	if let Some(context) = &composer.context {
		controls.push(FooterControl {
			id:      "composer-footer-context",
			surface: Some(SurfaceId::ContextBreakdownRefreshButton),
			icon:    IconName::Gauge,
			label:   context.label(),
			action:  FooterAction::Dispatch(Box::new(Intent::RefreshUsage)),
		});
	}

	controls
}

/// Draws one quiet text control (§6.9): icon, then the label unless the
/// footer is compact, on no ground, with a hairline wash on hover.
fn footer_control(
	control: FooterControl,
	labels: bool,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Stateful<Div> {
	let metrics = control_metrics(ButtonSize::Small, tokens);
	let availability = control
		.surface
		.as_ref()
		.map_or(Availability::Enabled, |surface| states.availability(surface));
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let is_label = matches!(control.action, FooterAction::Label);
	let ink = tokens.color(ColorRole::Secondary);

	let mut el = div()
		.id(ElementId::from(control.id))
		.h(metrics.height)
		.px(tokens.spacing(SpacingStep::S2))
		.rounded(metrics.radius)
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(metrics.gap)
		.opacity(opacity)
		.cursor(if is_label { CursorStyle::Arrow } else { cursor })
		.child(Icon::new(control.icon).size(IconSize::Size12).color(ink));

	if labels {
		el = el.child(
			div()
				.text_size(tokens.font_size(metrics.ramp))
				.line_height(tokens.line_height(metrics.ramp))
				.text_color(ink)
				.whitespace_nowrap()
				.child(control.label),
		);
	}

	if allowed && !is_label {
		let hover = tokens.row_hover();
		el = el.hover(move |style| style.bg(hover));
		el = match control.action {
			FooterAction::Dispatch(intent) => {
				el.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(intent.as_ref().clone());
					cx.notify();
				}))
			},
			FooterAction::PickFiles => {
				el.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.pick_attachments(cx);
				}))
			},
			FooterAction::Label => el,
		};
	}

	el
}

/// Builds the composer's footer row: the controls on the left, the turn
/// action on the right.
#[must_use]
pub fn footer_row(
	turn: &TurnPhase,
	composer: &ComposerState,
	has_text: bool,
	session_id: u64,
	labels: bool,
	states: &ControlStates,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let session = SessionId::from(session_id.to_string());
	let row_height = control_metrics(ButtonSize::Medium, tokens).height;

	let mut left = div()
		.id(ElementId::from("composer-footer-controls"))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.min_w_0()
		.overflow_hidden();

	for control in footer_controls(composer, &session)
		.into_iter()
		.take(geometry.footer_max_controls)
	{
		left = left.child(footer_control(control, labels, states, tokens, cx));
	}

	div()
		.id(ElementId::from("composer-footer"))
		.w_full()
		.h(row_height)
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(left)
		.child(turn_action_controls(turn, has_text, session_id, states, tokens, cx))
}
