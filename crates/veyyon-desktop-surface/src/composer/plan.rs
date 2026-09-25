//! The composer's plan chip for the board a session is working (§5.4).
//!
//! A plan is the agent's own record of what it set out to do, and the tally it
//! reports is the only place a window states how far through that list the run
//! is. The chip carries the tally at every width and the active phase when
//! there is room for it, so a narrow window sheds the phase name rather than
//! the numbers.

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet, Tooltip,
	controls::control_metrics,
};
use veyyon_desktop_model::{SessionId, SurfaceId, TodoBoardView};
use veyyon_gpui::{
	AnyElement, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, StatefulInteractiveElement, Styled, div,
};

use crate::{
	ShellView,
	controls::{ControlStates, availability_style},
	detail::{Detail, DetailKind},
};

/// The words the chip carries, and the sentence its tooltip states.
///
/// The tooltip names the task the run is on rather than repeating the tally,
/// which the chip already carries: a hover that restates what is on screen
/// costs a press and answers nothing.
fn wording(board: &TodoBoardView) -> (String, String) {
	let chip = board.chip_text();
	let detail = match board.current.as_ref() {
		Some(task) => format!("{} · {}", board.tally(), task.content),
		None if board.finished() => format!("{} · every task closed", board.tally()),
		None => format!("{} · no task open", board.tally()),
	};
	(chip, detail)
}

/// The plan chip, drawn only while the session holds a board.
///
/// The chip is absent rather than greyed when no plan is recorded, because
/// there is nothing to tally and nothing to explain: a run with no plan is the
/// ordinary case and the row belongs to the model name. Once a board exists an
/// unavailable capability still draws the chip, greyed with the host's reason,
/// since the tally is on screen and the sentence saying why it cannot be
/// opened is what the operator is missing (§4.3).
#[must_use]
pub fn plan_control(
	board: Option<&TodoBoardView>,
	session: &SessionId,
	states: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	let board = board?;
	let id = SurfaceId::ComposerPlanChip(session.clone());
	let availability = states.availability(&id);
	let (opacity, cursor, allowed) = availability_style(&availability, tokens);
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let (chip, detail) = wording(board);
	let label = availability.reason().unwrap_or(&detail).to_owned();
	let icon = if board.finished() {
		IconName::Check
	} else {
		IconName::Checklist
	};
	let mut control = div()
		.id("composer-footer-plan")
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
		.child(Icon::new(icon).size(IconSize::Size12))
		.child(
			div()
				.min_w_0()
				.truncate()
				.text_size(tokens.font_size(metrics.ramp))
				.line_height(tokens.line_height(metrics.ramp))
				.child(chip),
		);
	if allowed {
		let hover = tokens.row_hover();
		control = control.hover(move |style| style.bg(hover));
		// The chip carries no action of its own, so the plan is what a press
		// on it opens, whichever button it came from: a primary press because
		// a control that answers nothing is a dead one, and a secondary press
		// because that is how every other run that cut what it knows states
		// the rest (§8.25).
		for button in [MouseButton::Left, MouseButton::Right] {
			control = control.on_mouse_down(
				button,
				cx.listener(|view, event: &MouseDownEvent, window, cx| {
					view.toggle_detail(Detail::above(DetailKind::Plan, event.position), window, cx);
					cx.notify();
				}),
			);
		}
	}
	Some(Tooltip::new(label, control).above().into_any_element())
}
