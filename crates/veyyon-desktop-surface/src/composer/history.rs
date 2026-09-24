//! The composer's prompt history control (§5.4).
//!
//! A prompt submitted earlier is recalled rather than retyped. The control
//! opens the palette on the history mode, which lists the most recent prompts
//! before anything is typed and narrows them as it is.

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet, Tooltip,
	controls::control_metrics,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// What the control states when the host offers the history.
const RECALL_LABEL: &str = "Recall a prompt submitted earlier";

/// The prompt history control, drawn whenever the host reports the capability.
///
/// An unavailable capability still draws it, greyed with the host's reason on
/// it, because a control that disappears states nothing about why a prompt
/// cannot be recalled (§4.3).
#[must_use]
pub fn history_control(
	session: &SessionId,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let id = SurfaceId::ComposerHistoryButton(session.clone());
	let availability = states.availability(&id);
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let label = availability.reason().unwrap_or(RECALL_LABEL).to_owned();
	// The icon stands alone: the footer's width belongs to the model name, and
	// the history has nothing to state until it is opened.
	let mut control = div()
		.id("composer-footer-history")
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
		.text_color(tokens.color(ColorRole::Secondary))
		.child(Icon::new(IconName::History).size(IconSize::Size12));
	if allowed {
		let hover = tokens.row_hover();
		control = control
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _: &ClickEvent, _window, cx| {
				view.dispatch(Intent::FindPrompt(String::new()), cx);
			}));
	}
	Tooltip::new(label, control).above().into_any_element()
}
