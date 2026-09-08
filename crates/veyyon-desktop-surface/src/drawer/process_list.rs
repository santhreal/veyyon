//! Supervised processes list surface.
//!
//! Renders process rows (24px height) as kit `ListRow`s in a kit `List`: a
//! state `Dot` (6px), the name at body typography, PID and elapsed runtime at
//! micro tabular numbers, and the stop and restart controls.

use std::cell::RefCell;

use veyyon_desktop_kit::{
	ColorRole, Dot, List, ListRow, MonoSizeStep, MonoText, SpacingStep, TextRamp, TokenSet,
	controls::{Button, ButtonVariant},
	state::InteractiveState,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

use super::content::ProcessRow;
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// Builds the supervised processes list view.
pub fn process_list(
	processes: &[ProcessRow],
	controls: &ControlStates,
	session_id: u64,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	if processes.is_empty() {
		return div()
			.id("process-list")
			.w_full()
			.flex_1()
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.p(tokens.spacing(SpacingStep::S3))
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child("No supervised processes running"),
			)
			.into_any_element();
	}

	let rows: Vec<Option<AnyElement>> = processes
		.iter()
		.enumerate()
		.map(|(idx, proc)| Some(process_row(idx, proc, controls, session_id, geometry, tokens, cx)))
		.collect();
	let rows = RefCell::new(rows);
	div()
		.w_full()
		.flex_1()
		.flex()
		.flex_col()
		.px(tokens.spacing(SpacingStep::S3))
		.py(tokens.spacing(SpacingStep::S2))
		.child(
			List::new(processes.len(), move |index, _window, _cx| {
				rows
					.borrow_mut()
					.get_mut(index)
					.and_then(Option::take)
					.unwrap_or_else(|| div().into_any_element())
			})
			.id("process-list"),
		)
		.into_any_element()
}

/// One process row: the state dot leads, the name is the title, and the
/// numbers and controls trail.
fn process_row(
	idx: usize,
	proc: &ProcessRow,
	controls: &ControlStates,
	session_id: u64,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let is_running = proc.status == "running";
	let is_failed = proc.status == "failed" || proc.exit_code.is_some_and(|code| code != 0);
	let dot = if is_running {
		Dot::role(ColorRole::WorkingFill)
	} else if is_failed {
		Dot::role(ColorRole::ErrorFill)
	} else {
		Dot::role(ColorRole::Muted)
	};

	let name_for_stop = proc.name.clone();
	let name_for_restart = proc.name.clone();
	let name_for_send = proc.name.clone();
	let trailing = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(
			div()
				.mono_text(tokens, MonoSizeStep::Small)
				.text_color(tokens.color(ColorRole::Secondary))
				.child(
					proc
						.pid
						.map_or_else(|| "—".to_string(), |p| format!("pid {p}")),
				),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(proc.elapsed_label.clone()),
		)
		.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S1))
				.child({
					let sid = SessionId::from(session_id.to_string());
					let stop_av =
						controls.availability(&SurfaceId::ProcessStopButton(sid, proc.name.clone()));
					let (stop_op, _, stop_allowed) = availability_style(&stop_av, tokens);
					let mut btn = Button::new("Stop")
						.id(("process-stop", idx))
						.variant(ButtonVariant::Ghost);
					if is_running && stop_allowed {
						btn = btn.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
							view.dispatch(Intent::ProcessStop(name_for_stop.clone()), cx);
						}));
					} else {
						btn = btn.state(InteractiveState::Disabled);
					}
					div().opacity(stop_op).child(btn)
				})
				.child({
					let sid = SessionId::from(session_id.to_string());
					let restart_av =
						controls.availability(&SurfaceId::ProcessRestartButton(sid, proc.name.clone()));
					let (restart_op, _, restart_allowed) = availability_style(&restart_av, tokens);
					let mut btn = Button::new("Restart")
						.id(("process-restart", idx))
						.variant(ButtonVariant::Ghost);
					if restart_allowed {
						btn = btn.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
							view.dispatch(Intent::ProcessRestart(name_for_restart.clone()), cx);
						}));
					} else {
						btn = btn.state(InteractiveState::Disabled);
					}
					div().opacity(restart_op).child(btn)
				})
				.child({
					let sid = SessionId::from(session_id.to_string());
					let send_av =
						controls.availability(&SurfaceId::ProcessSendButton(sid, proc.name.clone()));
					let (send_op, _, send_allowed) = availability_style(&send_av, tokens);
					let mut btn = Button::new("Send")
						.id(("process-send", idx))
						.variant(ButtonVariant::Ghost);
					if is_running && send_allowed {
						btn = btn.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
							view.dispatch(
								Intent::ProcessSend { process: name_for_send.clone(), data: Vec::new() },
								cx,
							);
						}));
					} else {
						btn = btn.state(InteractiveState::Disabled);
					}
					div().opacity(send_op).child(btn)
				}),
		);

	ListRow::new(proc.name.clone())
		.id(("process-row", idx))
		.height(px(geometry.process_row_height_px))
		.leading(dot)
		.trailing(trailing)
		.into_any_element()
}
