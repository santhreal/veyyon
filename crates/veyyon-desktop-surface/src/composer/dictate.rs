//! The composer's microphone control (§5.4).
//!
//! Speech is recognised at the host and arrives as a view rather than as text
//! typed into the field, so the control states where the dictation is and what
//! has been heard so far while the words are still being said.

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet, Tooltip,
	controls::control_metrics,
};
use veyyon_desktop_model::{DictationState, DictationView, SessionId, SurfaceId};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// The microphone control, drawn whenever the host reports the capability.
///
/// An unavailable capability still draws it, greyed with the host's reason on
/// it, because a control that disappears states nothing about why dictation
/// cannot start (§4.3).
#[must_use]
pub fn dictate_control(
	dictation: Option<&DictationView>,
	session: &SessionId,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let id = SurfaceId::ComposerDictateButton(session.clone());
	let availability = states.availability(&id);
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let state = dictation.map_or(DictationState::Idle, |view| view.state);
	let base_label = dictation.map_or_else(
		|| DictationState::Idle.label().to_owned(),
		|view| {
			view
				.error
				.as_deref()
				.map_or_else(|| view.chip_text(), ToOwned::to_owned)
		},
	);
	let label = availability.reason().unwrap_or(&base_label).to_owned();
	// The ink states the microphone rather than the words: open is the accent
	// every live control in the window carries, and the word beside it is
	// secondary so a long preview does not read as an alert.
	let ink = if state.is_active() {
		ColorRole::Accent
	} else {
		ColorRole::Secondary
	};
	let mut control = div()
		.id("composer-footer-dictate")
		.aria_label(label.clone())
		.h(metrics.height)
		.min_w_0()
		.px(tokens.spacing(SpacingStep::S2))
		.rounded(metrics.radius)
		.flex()
		.items_center()
		.gap(metrics.gap)
		.opacity(opacity)
		.cursor(cursor)
		.text_color(tokens.color(ink))
		.child(Icon::new(IconName::Mic).size(IconSize::Size12));
	// Idle draws the microphone alone: the footer's width belongs to the model
	// name, and an idle dictation has nothing to state beyond the control.
	if state.is_active() || dictation.is_some_and(|view| view.error.is_some()) {
		control = control.child(
			div()
				.min_w_0()
				.truncate()
				.text_size(tokens.font_size(metrics.ramp))
				.line_height(tokens.line_height(metrics.ramp))
				.child(base_label),
		);
	}
	if allowed {
		let hover = tokens.row_hover();
		control = control
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _: &ClickEvent, _window, cx| {
				view.dispatch(Intent::ToggleDictation, cx);
			}));
		// A dictation that started by accident is discarded from the control
		// that started it, so stopping it never depends on recalling a key.
		if state.is_active() {
			control = control.on_mouse_down(
				MouseButton::Right,
				cx.listener(|view, _: &MouseDownEvent, _window, cx| {
					view.dispatch(Intent::CancelDictation, cx);
				}),
			);
		}
	}
	Tooltip::new(label, control).above().into_any_element()
}
