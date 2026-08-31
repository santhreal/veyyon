//! Task dashboard, including session phases and engine-reported task items.

use gpui::{
	AnyElement, App, Div, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Stateful,
	Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Capability, CapabilityStatus, CommandState, RemoteData, TaskPhaseView, TaskStatus, TaskView,
		TodoPhase,
	},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, layout, space},
	ui::{
		Badge, Banner, Button, Card, EdgeFade, Empty, Fill, Icon, Meter, Row, Scrolls, Size, Spinner,
		Tone, text,
	},
};

use super::{chrome, logic};
use crate::{act, agents::format};

pub fn render(store: &Store, now_ms: u64, scroll: &ScrollHandle, cx: &mut App) -> EdgeFade {
	let page = div()
		.id("task-dashboard")
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.min_h(px(0.0));
	if let veyyon_gui_core::model::ConnectionState::Fatal { message } = &store.connection {
		return page
			.child(
				Empty::new("Tasks unavailable")
					.icon(Icon::Failed)
					.note(message.clone())
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Canvas);
	}
	let content = match &store.replica.tasks {
		RemoteData::Unrequested => detached_or_unrequested(store),
		RemoteData::Loading { .. } => loading("Loading tasks"),
		RemoteData::Empty => ready(store, &[], now_ms, cx),
		RemoteData::Ready(value) => ready(store, &value.value, now_ms, cx),
		RemoteData::Stale { value, .. } => text::stack(space::BASE)
			.child(
				Banner::notice("Showing stale task data")
					.detail("The host is disconnected or resynchronizing."),
			)
			.child(ready(store, &value.value, now_ms, cx))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale } => {
			let mut state = text::stack(space::BASE).child(task_error(message, *retryable));
			if let Some(value) = stale {
				state = state.child(ready(store, &value.value, now_ms, cx));
			}
			state.into_any_element()
		},
	};
	page
		.child(
			div()
				.w_full()
				.max_w(px(layout::reading() + space::HUGE * 2.0))
				.p(px(space::HUGE))
				.child(content),
		)
		.scrolls_y(scroll, Elevation::Canvas)
}

fn ready(store: &Store, tasks: &[TaskView], now_ms: u64, cx: &mut App) -> AnyElement {
	let runtime = store.replica.runtime.readable().map(|value| &value.value);
	let phases = runtime
		.map(|runtime| runtime.todos.as_slice())
		.unwrap_or_default();
	if phases.is_empty() && tasks.is_empty() {
		return Empty::new("No tasks")
			.icon(Icon::Check)
			.note("The host reported no phase or task activity.")
			.into_any_element();
	}
	let mut body = text::stack(space::LOOSE);
	if !phases.is_empty() {
		body = body.child(phase_section(phases, cx));
	}
	if !tasks.is_empty() {
		body = body.child(task_section(store, tasks, now_ms, cx));
	}
	body.into_any_element()
}

fn phase_section(phases: &[TodoPhase], cx: &mut App) -> Card {
	let mut card = Card::new().child(text::heading("Session phases", &Theme::get(cx)));
	for phase in phases {
		card = card.child(phase_card(phase, cx));
	}
	card
}

fn phase_card(phase: &TodoPhase, cx: &mut App) -> Card {
	let mut card = chrome::phase_summary(
		phase.title.clone(),
		format!("{} items", phase.items.len()),
		Tone::Muted,
		0,
		0,
		cx,
	);
	for item in &phase.items {
		let item_owner = super::state::owner(&format!("phase-item-{}", item.id));
		card = card.child(
			Row::new(format!("phase-item-{}", item.id), item_owner, item.title.clone())
				.icon(Icon::Check)
				.child(Badge::new(item.status.clone()).tone(Tone::Muted)),
		);
	}
	card
}

fn task_section(store: &Store, tasks: &[TaskView], now_ms: u64, cx: &mut App) -> Div {
	let connected = store.connection.is_connected();
	let available = matches!(
		store.replica.capabilities.get(&Capability::Tasks),
		Some(CapabilityStatus::Available)
	);
	let mut section = text::stack(space::BASE).child(text::heading("Agent tasks", &Theme::get(cx)));
	for task in tasks {
		let cancellable =
			matches!(&task.status, TaskStatus::Pending | TaskStatus::Running | TaskStatus::Waiting);
		let command_state = store.command_state(&CommandTarget::Task(task.id.clone()));
		let pending = matches!(&command_state, CommandState::Pending { .. });
		let task_owner = super::state::task_owner(&task.id);
		let mut row = Row::new(format!("task-row-{}", task.id), task_owner, task.title.clone())
			.icon(logic::status_icon(&task.status))
			.note(task_note(task, now_ms))
			.child(
				Badge::new(logic::status_label(&task.status)).tone(logic::status_tone(&task.status)),
			);
		if cancellable {
			let cancel_owner = super::state::control_owner(&task.id, 1);
			let cancel_enabled = connected && available && !pending;
			let mut cancel_btn =
				Button::new(format!("cancel-task-{}", task.id), cancel_owner, Icon::Stop)
					.label("Abort")
					.size(Size::Base)
					.fill(Fill::Ghost)
					.tone(Tone::Danger)
					.tip("Abort this task")
					.on_click(act::click(UiCommand::CancelTask(task.id.clone())));
			if !cancel_enabled {
				cancel_btn = cancel_btn.disabled(if pending {
					"Wait for the pending task command"
				} else if !connected {
					"Reconnect to abort this task"
				} else if !available {
					"Task commands are unavailable from this host"
				} else {
					"Task cannot be aborted"
				});
			}
			row = row.hover_actions(veyyon_gui_kit::theme::layout::control_height(), cancel_btn);
		}
		let mut card = Card::new().child(row);
		if let Some(progress) = logic::progress(&task.status, task.progress_milli) {
			card = card.child(Meter::new(progress).bare());
		}
		card = card
			.child(chrome::relation("Assigned agent", task.agent.to_string(), cx))
			.child(chrome::relation("Assignment", task.assignment.clone(), cx));
		if let Some(description) = &task.description {
			card = card.child(chrome::relation("Description", description.clone(), cx));
		}
		if let Some(parent_tool) = &task.parent_tool {
			card = card.child(chrome::relation("Parent tool", parent_tool.to_string(), cx));
		}
		if let Some(duration) = task.duration_ms {
			card = card.child(chrome::relation("Duration", format::elapsed_label(duration), cx));
		}
		card = card.child(chrome::relation("Cost", format::cost_label(task.cost_microusd), cx));
		if let Some(message) = &task.message {
			card = card.child(chrome::relation("Update", message.clone(), cx));
		}
		for phase in &task.phases {
			card = card.child(task_phase(phase, cx));
		}
		if let Some(banner) = task_command_banner(&command_state) {
			card = card.child(banner);
		}
		section = section.child(card);
	}
	section
}

fn task_phase(phase: &TaskPhaseView, cx: &mut App) -> Stateful<Div> {
	let completed = phase
		.items
		.iter()
		.filter(|item| matches!(&item.status, TaskStatus::Completed))
		.count();
	let mut card = chrome::phase_summary(
		phase.title.clone(),
		logic::status_label(&phase.status),
		logic::status_tone(&phase.status),
		completed,
		phase.items.len(),
		cx,
	);
	for item in &phase.items {
		let note = match &item.detail {
			Some(detail) => detail.clone(),
			None => logic::status_label(&item.status).to_owned(),
		};
		let item_owner = super::state::owner(&format!("task-item-{}", item.id));
		card = card.child(
			Row::new(format!("task-item-{}", item.id), item_owner, item.title.clone())
				.icon(logic::status_icon(&item.status))
				.note(note)
				.child(
					Badge::new(logic::status_label(&item.status)).tone(logic::status_tone(&item.status)),
				),
		);
	}
	div()
		.id(format!("task-phase-{}", phase.id))
		.w_full()
		.child(card)
}

fn task_note(task: &TaskView, now_ms: u64) -> String {
	let duration = task
		.duration_ms
		.or_else(|| match (task.started_at_ms, task.ended_at_ms) {
			(Some(start), Some(end)) => Some(end.saturating_sub(start)),
			(Some(start), None)
				if matches!(&task.status, TaskStatus::Running | TaskStatus::Waiting) =>
			{
				Some(now_ms.saturating_sub(start))
			},
			_ => None,
		});
	duration
		.map(format::elapsed_label)
		.unwrap_or_else(|| logic::status_label(&task.status).to_owned())
}

pub fn next_elapsed_deadline(tasks: &[TaskView], now_ms: u64) -> Option<u64> {
	tasks
		.iter()
		.filter(|task| matches!(&task.status, TaskStatus::Running | TaskStatus::Waiting))
		.filter(|task| task.duration_ms.is_none())
		.filter_map(|task| {
			task
				.started_at_ms
				.map(|started| format::next_elapsed_deadline(started, now_ms))
		})
		.min()
}

fn detached_or_unrequested(store: &Store) -> AnyElement {
	if matches!(&store.connection, veyyon_gui_core::model::ConnectionState::Detached) {
		Empty::new("No host attached")
			.icon(Icon::Engine)
			.note("Attach a host to load task and phase progress.")
			.into_any_element()
	} else {
		Empty::new("Task data not requested")
			.icon(Icon::Notice)
			.note("Load the host's current task and phase progress.")
			.child(
				Button::labelled("load-tasks", super::state::owner("load-tasks"), "Load tasks")
					.icon(Icon::Return)
					.fill(Fill::Tinted)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::RefreshAgents)),
			)
			.into_any_element()
	}
}

fn loading(label: &'static str) -> AnyElement {
	div()
		.flex()
		.items_center()
		.justify_center()
		.gap(px(space::BASE))
		.p(px(space::HUGE))
		.child(Spinner::new(super::state::owner("tasks-loading"), Icon::Running))
		.child(label)
		.into_any_element()
}

fn task_command_banner(state: &CommandState) -> Option<Banner> {
	match state {
		CommandState::Idle => None,
		CommandState::Pending { request } => {
			Some(Banner::waiting("Task command pending").detail(format!("Request {}", request.get())))
		},
		CommandState::Failed { request, message } => Some(
			Banner::failure("Task command failed")
				.detail(format!("Request {} · {message}", request.get())),
		),
	}
}

fn task_error(message: &str, retryable: bool) -> Banner {
	let mut banner = Banner::failure("Task dashboard unavailable").detail(message.to_owned());
	if retryable {
		banner = banner.child(
			Button::labelled(
				"retry-task-dashboard",
				super::state::owner("retry-task-dashboard"),
				"Retry",
			)
			.icon(Icon::Return)
			.fill(Fill::Tinted)
			.tone(Tone::Accent)
			.on_click(act::click(UiCommand::RefreshAgents)),
		);
	}
	banner
}
