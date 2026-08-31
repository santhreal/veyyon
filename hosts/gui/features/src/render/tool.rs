//! Tool invocations, lifecycle states, arguments, and producer-owned results.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	UiCommand,
	model::{ToolCallView, ToolId, ToolState, Value},
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Button, Fill, Icon, Size, Tone, disclosure::Disclosure, text},
};

use super::{generic_json, identity};
use crate::act;

pub fn result(id: &str, tool_id: &ToolId, value: &Value, is_error: bool, cx: &mut App) -> Div {
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(
			Badge::new(format!("Result · {tool_id}"))
				.tone(if is_error { Tone::Danger } else { Tone::Muted })
				.icon(if is_error { Icon::Failed } else { Icon::Tool }),
		)
		.child(generic_json::detail(id, value, cx))
}

/// Render a canonical tool call. `None` is a retained invocation whose
/// lifecycle snapshot has not arrived; it remains visible as unavailable.
pub fn call(
	id: &ToolId,
	name: &str,
	arguments: &Value,
	view: Option<&ToolCallView>,
	open: bool,
	cx: &mut App,
) -> Div {
	let shown_arguments = view.map_or(arguments, |view| &view.arguments);
	let result = view.and_then(|view| view.result.as_ref());
	let has_arguments = !matches!(shown_arguments, Value::Null);
	let has_detail = has_arguments || result.is_some();
	let label = view
		.and_then(|view| view.intent.as_deref())
		.filter(|intent| !intent.trim().is_empty())
		.unwrap_or(name);

	let disclosure_id = format!("tool-{id}");
	let mut disclosure =
		Disclosure::new(disclosure_id.clone(), identity::owner(&disclosure_id), label.to_owned())
			.open(open)
			.count(state_label(view.map(|view| &view.state)));
	if has_detail {
		let command_id = id.clone();
		disclosure = disclosure.on_toggle(move |_, window, cx| {
			act::run(UiCommand::ToggleToolDisclosure(command_id.clone()), window, cx);
		});
	}

	if open {
		if has_arguments {
			disclosure = disclosure.child(
				text::stack(space::TIGHT)
					.w_full()
					.min_w(px(0.0))
					.child(Badge::new("Arguments").tone(Tone::Muted).bare())
					.child(generic_json::detail(&format!("tool-{id}-args"), shown_arguments, cx)),
			);
		}
		if let Some(result) = result {
			disclosure = disclosure.child(
				text::stack(space::TIGHT)
					.w_full()
					.min_w(px(0.0))
					.child(
						Badge::new("Result")
							.tone(if view.is_some_and(|view| view.is_error) {
								Tone::Danger
							} else {
								Tone::Muted
							})
							.bare(),
					)
					.child(generic_json::detail(&format!("tool-{id}-result"), result, cx)),
			);
		}
	}

	let mut column = text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(disclosure);
	match view.map(|view| &view.state) {
		Some(ToolState::Pending | ToolState::Running | ToolState::StreamingResult) => {
			let cancel_id = id.clone();
			let cancel_control_id = format!("cancel-tool-{id}");
			column = column.child(
				div().flex().justify_end().child(
					Button::labelled(
						cancel_control_id.clone(),
						identity::owner(&cancel_control_id),
						"Cancel",
					)
					.icon(Icon::Stop)
					.tone(Tone::Danger)
					.fill(Fill::Ghost)
					.size(Size::Base)
					.tip("Cancel tool")
					.on_click(act::click(UiCommand::CancelTool(cancel_id))),
				),
			);
		},
		Some(ToolState::WaitingForApproval) => {
			column = column.child(
				Badge::new("Waiting for approval")
					.tone(Tone::Warn)
					.icon(Icon::Allow),
			);
		},
		Some(ToolState::Failed) => {
			column = column.child(
				Badge::new("Tool failed")
					.tone(Tone::Danger)
					.icon(Icon::Failed),
			);
		},
		Some(ToolState::Cancelled) => {
			column = column.child(Badge::new("Cancelled").tone(Tone::Muted));
		},
		Some(ToolState::Interrupted) => {
			column = column.child(Badge::new("Interrupted").tone(Tone::Warn));
		},
		Some(ToolState::Succeeded) => {},
		None => {
			column = column.child(Badge::new("Tool state unavailable").tone(Tone::Warn));
		},
	}
	column
}

fn state_label(state: Option<&ToolState>) -> &'static str {
	match state {
		Some(ToolState::Pending) => "pending",
		Some(ToolState::WaitingForApproval) => "approval",
		Some(ToolState::Running) => "running",
		Some(ToolState::StreamingResult) => "streaming",
		Some(ToolState::Succeeded) => "succeeded",
		Some(ToolState::Failed) => "failed",
		Some(ToolState::Cancelled) => "cancelled",
		Some(ToolState::Interrupted) => "interrupted",
		None => "unavailable",
	}
}

pub fn mark(name: &str) -> Icon {
	let normalized = name.to_ascii_lowercase();
	if normalized.contains("read") {
		Icon::Read
	} else if normalized.contains("write") || normalized.contains("edit") {
		Icon::Edited
	} else if normalized.contains("search") || normalized.contains("glob") {
		Icon::Search
	} else if normalized.contains("bash")
		|| normalized.contains("shell")
		|| normalized.contains("python")
	{
		Icon::Ran
	} else {
		Icon::Tool
	}
}
