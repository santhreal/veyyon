//! Context settings and confirmed queue delivery modes.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{CommandState, InterruptMode, QueueDelivery, QueueState, SessionRuntimeView, Versioned},
	navigation::SettingsPage,
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Badge, Banner, Field, Fill, Group, Size, Tone, text},
};

use super::{remote, schema};
use crate::act;

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	text::stack(space::LOOSE)
		.child(text::title("Context", &theme))
		.child(queue_surface(store, cx))
		.child(schema::render_embedded(store, SettingsPage::Context, cx))
		.into_any_element()
}

fn queue_surface(store: &Store, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.runtime,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading queue modes",
			empty:       "No active session runtime",
			empty_note:  "Queue modes appear after a session is opened.",
			detached:    "Queue modes are not loaded",
			unavailable: "Queue modes are unavailable",
		},
		UiCommand::LoadSessions,
		|versioned: &Versioned<SessionRuntimeView>, mutable, cx| {
			queue_fields(store, &versioned.value, mutable, cx)
		},
		cx,
	)
}

fn queue_fields(
	store: &Store,
	runtime: &SessionRuntimeView,
	mutable: bool,
	_cx: &mut App,
) -> AnyElement {
	let command = store.command_state(&CommandTarget::Session(runtime.session.clone()));
	let pending = matches!(command, CommandState::Pending { .. });
	let mut content = text::stack(space::BASE).child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::SNUG))
			.child(Badge::new(format!("{} queued", runtime.queue.count)).exact())
			.child(
				Badge::new(format!("Active: {}", submission(runtime.queue.active_submission))).bare(),
			),
	);
	if let CommandState::Failed { message, .. } = command {
		content = content.child(Banner::failure("Queue mode change failed").detail(message));
	}
	content
		.child(
			Group::new("Delivery")
				.note("Each change keeps the other two confirmed modes unchanged.")
				.child(
					Field::new("Steering messages")
						.stacked()
						.child(delivery_buttons(
							"steering",
							&runtime.queue,
							true,
							mutable && !pending,
							runtime,
						)),
				)
				.child(
					Field::new("Follow-up messages")
						.stacked()
						.child(delivery_buttons(
							"follow-up",
							&runtime.queue,
							false,
							mutable && !pending,
							runtime,
						)),
				)
				.child(
					Field::new("Interrupt behavior")
						.stacked()
						.child(interrupt_buttons(runtime, mutable && !pending)),
				),
		)
		.into_any_element()
}

fn delivery_buttons(
	id: &str,
	queue: &QueueState,
	steering: bool,
	mutable: bool,
	runtime: &SessionRuntimeView,
) -> AnyElement {
	let current = if steering {
		&queue.steering
	} else {
		&queue.follow_up
	};
	let mut row = div().flex().flex_wrap().gap(px(space::SNUG));
	for choice in [QueueDelivery::Immediate, QueueDelivery::Queued, QueueDelivery::Disabled] {
		let selected = current == &choice;
		let steering_value = if steering {
			choice.clone()
		} else {
			queue.steering.clone()
		};
		let follow_up = if steering {
			queue.follow_up.clone()
		} else {
			choice.clone()
		};
		let mut btn = crate::settings::controls::button(
			format!("queue-{id}-{}", delivery(&choice)),
			delivery(&choice),
		)
		.size(Size::Small)
		.fill(if selected { Fill::Tinted } else { Fill::Ghost })
		.tone(if selected { Tone::Accent } else { Tone::Muted })
		.on(selected);
		if !mutable {
			btn = btn.disabled("Queue mode is read-only or change is pending");
		} else {
			btn = btn.on_click(act::click(UiCommand::SetQueueMode {
				session: runtime.session.clone(),
				steering: steering_value,
				follow_up,
				interrupt: queue.interrupt.clone(),
			}));
		}
		row = row.child(btn);
	}
	row.into_any_element()
}

fn interrupt_buttons(runtime: &SessionRuntimeView, mutable: bool) -> AnyElement {
	let mut row = div().flex().flex_wrap().gap(px(space::SNUG));
	for choice in [InterruptMode::AbortThenSend, InterruptMode::Queue, InterruptMode::Disabled] {
		let selected = runtime.queue.interrupt == choice;
		let mut btn = crate::settings::controls::button(
			format!("queue-interrupt-{}", interrupt(&choice)),
			interrupt(&choice),
		)
		.size(Size::Small)
		.fill(if selected { Fill::Tinted } else { Fill::Ghost })
		.tone(if selected { Tone::Accent } else { Tone::Muted })
		.on(selected);
		if !mutable {
			btn = btn.disabled("Queue mode is read-only or change is pending");
		} else {
			btn = btn.on_click(act::click(UiCommand::SetQueueMode {
				session:   runtime.session.clone(),
				steering:  runtime.queue.steering.clone(),
				follow_up: runtime.queue.follow_up.clone(),
				interrupt: choice,
			}));
		}
		row = row.child(btn);
	}
	row.into_any_element()
}

fn delivery(mode: &QueueDelivery) -> &str {
	match mode {
		QueueDelivery::Immediate => "Immediate",
		QueueDelivery::Queued => "Queued",
		QueueDelivery::Disabled => "Disabled",
		QueueDelivery::Unknown(value) => value,
	}
}

fn interrupt(mode: &InterruptMode) -> &str {
	match mode {
		InterruptMode::AbortThenSend => "Abort then send",
		InterruptMode::Queue => "Queue",
		InterruptMode::Disabled => "Disabled",
		InterruptMode::Unknown(value) => value,
	}
}

fn submission(mode: veyyon_gui_core::model::SubmissionMode) -> &'static str {
	match mode {
		veyyon_gui_core::model::SubmissionMode::Prompt => "Prompt",
		veyyon_gui_core::model::SubmissionMode::Steer => "Steer",
		veyyon_gui_core::model::SubmissionMode::FollowUp => "Follow-up",
	}
}
