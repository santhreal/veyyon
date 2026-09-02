//! Primary and secondary turn action controls and abort button rendering
//! (§5.4).
//!
//! Renders the primary action button (Send, Steer, Queue, Answer, Approve,
//! Accept, Refine) using either a dedicated action button or a `SplitButton`
//! when queue mode selection is active. `AbortTurn` is rendered as an isolated
//! 28px square control, shown only during active execution.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, Icon, IconName, IconSize, InteractiveState,
	RadiusStep, SpacingStep, SplitButton, TokenSet,
};
use veyyon_desktop_model::{InteractionId, QueueMode, SessionId, SurfaceId};
use veyyon_gpui::{
	ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use super::turn::{PrimaryAction, SecondaryAction, TurnPhase, primary_action};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// Resolves the corresponding `SurfaceId` for a primary action kind.
#[must_use]
pub fn primary_surface_id(action: PrimaryAction, session_id: &SessionId) -> SurfaceId {
	let dummy_interaction = InteractionId::from("current");
	match action {
		PrimaryAction::Send => SurfaceId::ComposerSendButton(session_id.clone()),
		PrimaryAction::Steer => SurfaceId::ComposerSteerButton(session_id.clone()),
		PrimaryAction::Queue => SurfaceId::ComposerQueueButton(session_id.clone()),
		PrimaryAction::Answer => {
			SurfaceId::QuestionSubmitButton(session_id.clone(), dummy_interaction)
		},
		PrimaryAction::Approve => {
			SurfaceId::ApprovalApproveButton(session_id.clone(), dummy_interaction)
		},
		PrimaryAction::Accept => SurfaceId::PlanAcceptButton(session_id.clone(), dummy_interaction),
		PrimaryAction::Refine => SurfaceId::PlanRefineButton(session_id.clone(), dummy_interaction),
	}
}

/// Builds the right-aligned container with the abort button (if running) and
/// primary/split button.
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
	let (primary, secondary) = primary_action(turn, has_text);
	let primary_id = primary_surface_id(primary, &sid);
	let av = controls.availability(&primary_id);
	let (opacity, _cursor, allowed) = availability_style(&av, tokens);

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
					view.dispatch(Intent::AbortTurn);
					cx.notify();
				},
			));
		}

		container = container.child(abort_btn);
	}

	let actionable = match primary {
		PrimaryAction::Send | PrimaryAction::Steer | PrimaryAction::Queue | PrimaryAction::Refine => {
			has_text
		},
		PrimaryAction::Answer | PrimaryAction::Approve | PrimaryAction::Accept => true,
	};

	let variant = if actionable && allowed {
		ButtonVariant::Primary
	} else {
		ButtonVariant::Default
	};
	let state = if allowed {
		InteractiveState::Default
	} else {
		InteractiveState::Disabled
	};

	let primary_element = if let Some(mode @ (SecondaryAction::Queue | SecondaryAction::Steer)) = secondary {
 			// The secondary half switches the queue mode to the one the
 			// primary is not, so the operator can reach either from one control.
 			let mode = if mode == SecondaryAction::Queue {
 				QueueMode::Queue
 			} else {
 				QueueMode::Steer
 			};
 			let mut btn = SplitButton::new(primary.label())
 				.id(ElementId::from("composer-primary-split"))
 				.variant(variant)
 				.size(ButtonSize::Small)
 				.state(state);

 			if allowed {
 				btn = btn
 					.on_primary(cx.listener(|view, _ev: &ClickEvent, _win, cx| {
 						view.submit_primary_turn_action(cx);
 						cx.notify();
 					}))
 					.on_secondary(cx.listener(move |view, _ev: &ClickEvent, _win, cx| {
 						view.dispatch(Intent::SetQueueMode(mode));
 						cx.notify();
 					}));
 			}

 			// Opacity alone on the wrapper: a cursor here would register a
 			// second hit rect over the button's own.
 			div()
 				.id(ElementId::from("composer-split-action"))
 				.opacity(opacity)
 				.child(btn)
 		} else {
 			let mut btn = Button::new(primary.label())
 				.id(ElementId::from("composer-primary-action"))
 				.variant(variant)
 				.size(ButtonSize::Small)
 				.state(state);

 			if allowed {
 				btn = btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
 					view.submit_primary_turn_action(cx);
 					cx.notify();
 				}));
 			}

 			div()
 				.id(ElementId::from("composer-action-btn-wrap"))
 				.opacity(opacity)
 				.child(btn)
 		};

	container.child(primary_element)
}
