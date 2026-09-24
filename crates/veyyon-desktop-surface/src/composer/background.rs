//! The composer's background control for a command the turn waits on (§5.4).
//!
//! A command that outlives the turn it was started in holds the session: the
//! agent cannot answer until it exits. The control moves that command to a
//! background job and hands the turn back, leaving the command running and its
//! output collected.

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet, Tooltip,
	controls::control_metrics,
};
use veyyon_desktop_model::{ForegroundCommandView, SessionId, SurfaceId};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// The background control, drawn only while a command is waited on.
///
/// The control is absent rather than greyed when nothing waits, because there
/// is no command to name and no state to explain: the row it would occupy
/// belongs to the model name for every turn that runs no command (§4.3). While
/// a wait is open an unavailable capability still draws it, greyed with the
/// host's reason, since the operator can see the command that is holding the
/// turn and needs the sentence saying why it cannot be moved.
#[must_use]
pub fn background_control(
	foreground: Option<&ForegroundCommandView>,
	session: &SessionId,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	let waiting = foreground?;
	let id = SurfaceId::ComposerBackgroundButton(session.clone());
	let availability = states.availability(&id);
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let label = availability
		.reason()
		.map_or_else(|| waiting.label(), str::to_owned);
	let mut control = div()
		.id("composer-footer-background")
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
		.child(Icon::new(IconName::Layers).size(IconSize::Size12));
	if allowed {
		let hover = tokens.row_hover();
		control = control
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _: &ClickEvent, _window, cx| {
				view.dispatch(Intent::BackgroundCommand, cx);
			}));
	}
	Some(Tooltip::new(label, control).above().into_any_element())
}
