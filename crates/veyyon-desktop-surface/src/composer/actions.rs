//! Up-arrow turn submission and the separate running-turn stop control.

use veyyon_desktop_kit::{
	ButtonSize, ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TokenSet, Tooltip,
	controls::control_metrics,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use super::turn::{PrimaryAction, TurnPhase, primary_action};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// The request control for a composer intent; local editor intents have no
/// request control.
#[must_use]
pub fn request_surface(intent: &Intent, session: &SessionId) -> Option<SurfaceId> {
	Some(match intent {
		Intent::Send { .. } => SurfaceId::ComposerSendButton(session.clone()),
		Intent::Steer(_) => SurfaceId::ComposerSteerButton(session.clone()),
		Intent::Queue(_) => SurfaceId::ComposerQueueButton(session.clone()),
		Intent::AbortTurn => SurfaceId::ComposerAbortButton(session.clone()),
		Intent::SetQueueMode(_) => SurfaceId::ComposerQueueModeToggle(session.clone()),
		Intent::SelectModel(_) => SurfaceId::ComposerModelSelector(session.clone()),
		Intent::SetThinking(_) => SurfaceId::ComposerThinkingSelector(session.clone()),
		_ => return None,
	})
}

/// Builds the up-arrow submission control and the separate running-turn stop
/// control.
#[must_use]
pub fn turn_action_controls(
	turn: &TurnPhase,
	has_text: bool,
	session_id: u64,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let sid = SessionId::from(session_id.to_string());
	let (primary, _) = primary_action(turn, has_text);
	let primary_id = turn.primary_surface(has_text, &sid);
	let av = controls.availability(&primary_id);
	let (opacity, cursor, allowed) = availability_style(&av, tokens);

	let mut container = div()
		.id(ElementId::from("composer-actions-container"))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.flex_shrink_0();

	// AbortTurn is an isolated 28px control, shown only while actively running
	// (§5.4).
	if turn.is_running() {
		let abort_id = SurfaceId::ComposerAbortButton(sid);
		let abort_av = controls.availability(&abort_id);
		let (abort_opacity, abort_cursor, abort_allowed) = availability_style(&abort_av, tokens);
		let hover = tokens.row_hover();

		let mut abort_btn = div()
			.id(ElementId::from("composer-abort-turn"))
			.w(px(28.0))
			.h(px(28.0))
			.flex()
			.items_center()
			.justify_center()
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tokens.color(ColorRole::ErrorFill))
			.opacity(abort_opacity)
			.cursor(abort_cursor)
			.child(
				Icon::new(IconName::Stop)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::ErrorInk)),
			);

		if abort_allowed {
			abort_btn = abort_btn.hover(move |s| s.bg(hover)).on_click(cx.listener(
				|view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::AbortTurn, cx);
				},
			));
		}

		container = container.child(with_reason(abort_btn, abort_av.reason(), "abort"));
	}

	let actionable = match primary {
		PrimaryAction::Send | PrimaryAction::Steer | PrimaryAction::Queue | PrimaryAction::Refine => {
			has_text
		},
		PrimaryAction::Answer | PrimaryAction::Approve | PrimaryAction::Accept => true,
	};

	let active = allowed && actionable;
	let metrics = control_metrics(ButtonSize::Medium, tokens);
	let label = av.reason().unwrap_or_else(|| primary.label()).to_owned();
	let mut button = div()
		.id("composer-primary-action")
		.aria_label(label.clone())
		.w(metrics.square)
		.h(metrics.square)
		.rounded(metrics.radius)
		.flex()
		.items_center()
		.justify_center()
		.flex_shrink_0()
		.opacity(if actionable {
			opacity
		} else {
			metrics.disabled_opacity
		})
		.cursor(if active {
			cursor
		} else {
			veyyon_gpui::CursorStyle::OperationNotAllowed
		})
		.bg(tokens.color(ColorRole::Accent))
		.child(
			Icon::new(IconName::ArrowUp)
				.size(IconSize::Size12)
				.color(tokens.color(ColorRole::AccentForeground)),
		);
	if active {
		let hover = tokens.color(ColorRole::Focus);
		button = button
			.hover(move |style| style.bg(hover))
			.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.submit_primary_turn_action(cx);
			}));
	}
	container.child(Tooltip::new(label, button).group("composer-primary-hint"))
}

/// Wraps a control in the host's reason for holding it back, readable on
/// hover, or returns it bare while it is available (§4.3).
fn with_reason(control: impl IntoElement, reason: Option<&str>, slot: &str) -> AnyElement {
	match reason {
		Some(reason) => Tooltip::new(reason.to_owned(), control)
			.group(format!("composer-reason-{slot}"))
			.into_any_element(),
		None => control.into_any_element(),
	}
}
