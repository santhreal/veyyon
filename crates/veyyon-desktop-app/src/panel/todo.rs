//! The todo tab: the plan the displayed session is working, phase by phase,
//! with the tallies the host computed.

use veyyon_desktop_model::{TodoStatus, TodoTaskView};
use veyyon_desktop_ui::theme::{Palette, TypeStyled, space, text};
use veyyon_gpui::{AnyElement, Div, IntoElement, ParentElement, Styled, div, prelude::*};

use super::style::{empty_state, heading, toolbar};
use crate::AppState;

/// The tab's body for the displayed session.
pub fn render(app: &AppState, palette: &Palette) -> AnyElement {
	let Some(board) = app
		.active_session()
		.and_then(|session| app.store().domains.todo.get(session))
	else {
		return empty_state(
			"The agent has not written a plan for this session",
			None::<Div>,
			palette,
		)
		.into_any_element();
	};
	let summary = toolbar(palette)
		.px(space::S3)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.truncate()
				.type_style(text::UI_MEDIUM)
				.text_color(palette.text.primary)
				.child(
					board
						.current
						.as_ref()
						.map_or_else(|| "Every task is closed".to_owned(), |task| task.content.clone()),
				),
		)
		.child(
			div()
				.flex_none()
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(board.tally()),
		);
	let mut body = div()
		.id("todo-board")
		.flex()
		.flex_col()
		.flex_1()
		.min_h_0()
		.overflow_y_scroll()
		.pb(space::S3);
	for phase in &board.phases {
		body = body
			.child(
				heading(phase.name.clone(), palette)
					.when(phase.active, |el| el.text_color(palette.text.primary))
					.child(div().flex_1())
					.child(phase.tally()),
			)
			.children(phase.tasks.iter().map(|task| task_row(task, palette)));
	}
	div()
		.flex()
		.flex_col()
		.size_full()
		.child(summary)
		.child(body)
		.into_any_element()
}

/// One task: its status mark and its words, struck through once closed.
fn task_row(task: &TodoTaskView, palette: &Palette) -> Div {
	let color = match task.status {
		TodoStatus::InProgress => palette.status.running,
		TodoStatus::Completed => palette.status.success,
		TodoStatus::Pending | TodoStatus::Abandoned => palette.text.muted,
	};
	div()
		.flex()
		.items_start()
		.gap(space::S2)
		.px(space::S3)
		.py(space::S1)
		.type_style(text::UI)
		.child(
			div()
				.flex_none()
				.text_color(color)
				.child(task.status.mark()),
		)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.text_color(if task.status.closed() {
					palette.text.muted
				} else {
					palette.text.primary
				})
				.when(task.status.closed(), |el| el.line_through())
				.child(task.content.clone()),
		)
}
