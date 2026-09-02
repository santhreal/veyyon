//! Supervised processes list surface.
//!
//! Renders process rows (24px height): state dot (6px), name at body
//! typography, PID and elapsed runtime at micro tabular numbers, and action
//! buttons on hover.

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{Button, ButtonVariant},
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use super::content::ProcessRow;
use crate::{Intent, ShellView};

/// Builds the supervised processes list view.
pub fn process_list(
	processes: &[ProcessRow],
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut list = div()
		.id("process-list")
		.flex()
		.flex_col()
		.w_full()
		.flex_1()
		.overflow_y_scroll()
		.px(tokens.spacing(SpacingStep::S3))
		.py(tokens.spacing(SpacingStep::S2));

	if processes.is_empty() {
		return list.child(
			div()
				.p(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child("No supervised processes running"),
		);
	}

	for (idx, proc) in processes.iter().enumerate() {
		let is_running = proc.status == "running";
		let is_failed = proc.status == "failed" || proc.exit_code.is_some_and(|code| code != 0);

		let dot_color = if is_running {
			tokens.color(ColorRole::WorkingFill)
		} else if is_failed {
			tokens.color(ColorRole::ErrorFill)
		} else {
			tokens.color(ColorRole::Muted)
		};

		let name = proc.name.clone();
		let name_for_stop = name.clone();
		let name_for_restart = name.clone();

		let row = div()
			.h(px(geometry.process_row_height_px))
			.w_full()
			.flex()
			.flex_row()
			.items_center()
			.justify_between()
			.px(tokens.spacing(SpacingStep::S2))
			.rounded(tokens.radius(RadiusStep::Sm))
			.hover(|s| s.bg(tokens.color(ColorRole::Canvas)))
			.child(
				div()
					.flex()
					.flex_row()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(
						div()
							.size(px(geometry.process_dot_px))
							.rounded_full()
							.bg(dot_color),
					)
					.child(
						div()
							.text_size(tokens.font_size(TextRamp::Body))
							.line_height(tokens.line_height(TextRamp::Body))
							.font_weight(tokens.font_weight(TextWeight::Medium))
							.text_color(tokens.color(ColorRole::Foreground))
							.child(proc.name.clone()),
					),
			)
			.child(
				div()
					.flex()
					.flex_row()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S3))
					.child(
						div()
							.text_size(tokens.mono_font_size(MonoSizeStep::Small))
							.line_height(tokens.mono_line_height(MonoSizeStep::Small))
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
							.child(
								Button::new("Stop")
									.id(("process-stop", idx))
									.variant(ButtonVariant::Ghost)
									.on_click(cx.listener(
										move |view, _event: &ClickEvent, _window, _cx| {
											view.dispatch(Intent::ProcessStop(name_for_stop.clone()));
										},
									)),
							)
							.child(
								Button::new("Restart")
									.id(("process-restart", idx))
									.variant(ButtonVariant::Ghost)
									.on_click(cx.listener(
										move |view, _event: &ClickEvent, _window, _cx| {
											view.dispatch(Intent::ProcessRestart(name_for_restart.clone()));
										},
									)),
							),
					),
			);

		list = list.child(row);
	}

	list
}
