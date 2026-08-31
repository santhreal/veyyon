//! Provider, thinking, queue-mode, and attachment controls.

use gpui::{Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Availability, Capability, CapabilityStatus, InterruptMode, ModelCatalogState, QueueDelivery,
		SessionId, SessionRuntimeView,
	},
	navigation::Overlay,
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Button, Icon},
};

use super::{
	logic,
	state::{Control, control_owner},
};
use crate::act;

pub fn composer_controls(store: &Store, runtime: Option<&SessionRuntimeView>) -> Div {
	let selected = store.frontend.selected_session.as_ref();
	let mut controls = div().flex().flex_wrap().items_center().gap(px(space::X4));
	let mut files = Button::new("choose-files", control_owner(Control::Files), Icon::Attachment)
		.tip("Attach files");
	let mut images = Button::new("choose-images", control_owner(Control::Images), Icon::Image)
		.tip("Attach images");
	let mut mention = Button::new("mention-context", control_owner(Control::Mention), Icon::Mention)
		.tip("Mention a file");
	if let Some(session) = selected {
		files = files.on_click(act::click(UiCommand::ChooseFiles { session: session.clone() }));
		images = images.on_click(act::click(UiCommand::ChooseImages { session: session.clone() }));
		mention = mention.on_click(act::click(UiCommand::OpenOverlay(Overlay::QuickOpen)));
		if let Some(reason) = attachment_limit_reason(store, runtime) {
			files = files.disabled(reason.clone());
			images = images.disabled(reason);
		} else if let Some(runtime) = runtime
			&& !runtime.prompt_constraints.allowed_modalities.is_empty()
			&& !runtime
				.prompt_constraints
				.allowed_modalities
				.iter()
				.any(|modality| modality.eq_ignore_ascii_case("image"))
		{
			images = images.disabled("The active model does not accept image attachments");
		}
	} else {
		let reason = "Select or create a conversation before adding context";
		files = files.disabled(reason);
		images = images.disabled(reason);
		mention = mention.disabled(reason);
	}
	controls = controls
		.child(files)
		.child(images)
		.child(mention)
		.child(model_control(store))
		.child(thinking_control(store));
	if let (Some(session), Some(runtime)) = (selected, runtime) {
		controls = controls
			.child(queue_control(session, runtime, QueueControl::Steering))
			.child(queue_control(session, runtime, QueueControl::FollowUp))
			.child(queue_control(session, runtime, QueueControl::Interrupt));
	}
	controls
}

fn model_control(store: &Store) -> Button {
	let catalog = store
		.replica
		.models
		.readable()
		.map(|version| &version.value);
	let label = catalog
		.and_then(selected_model_label)
		.unwrap_or_else(|| "Choose model".to_owned());
	let mut button = Button::labelled("composer-model", control_owner(Control::Model), label)
		.icon(Icon::Model)
		.on_click(act::click(UiCommand::OpenOverlay(Overlay::ModelPicker)));
	if let Some(reason) = capability_reason(store, Capability::Models) {
		button = button.disabled(reason);
	}
	button
}

fn selected_model_label(catalog: &ModelCatalogState) -> Option<String> {
	let (provider, model) = catalog.selected.as_ref()?;
	let option = catalog
		.models
		.readable()?
		.iter()
		.find(|option| &option.provider == provider && &option.id == model)?;
	let unavailable = matches!(&option.availability, Availability::Unavailable { .. });
	Some(if unavailable {
		format!("{} · unavailable", option.name)
	} else {
		option.name.clone()
	})
}

fn thinking_control(store: &Store) -> Button {
	let catalog = store
		.replica
		.models
		.readable()
		.map(|version| &version.value);
	let thinking = catalog.map(|catalog| &catalog.thinking);
	let current = thinking.and_then(|thinking| {
		thinking
			.effective
			.as_deref()
			.or(thinking.configured.as_deref())
	});
	let mut button = Button::labelled(
		"composer-thinking",
		control_owner(Control::Thinking),
		current
			.map_or_else(|| "Thinking unavailable".to_owned(), |level| format!("Thinking {level}")),
	)
	.icon(Icon::Thinking);
	let next = thinking.and_then(|thinking| {
		let current_index = current.and_then(|current| {
			thinking
				.supported_efforts
				.iter()
				.position(|effort| effort == current)
		});
		let next_index =
			current_index.map_or(0, |index| (index + 1) % thinking.supported_efforts.len().max(1));
		thinking.supported_efforts.get(next_index).cloned()
	});
	if let Some(next) = next {
		button = button
			.tip(format!("Set thinking level to {next}"))
			.on_click(act::click(UiCommand::SetThinkingLevel(next)));
	} else {
		button = button.disabled("The active model does not expose thinking levels");
	}
	if !store.connection.is_connected() {
		button = button.disabled("Reconnect before changing the thinking level");
	}
	button
}

#[derive(Clone, Copy)]
enum QueueControl {
	Steering,
	FollowUp,
	Interrupt,
}

fn queue_control(
	session: &SessionId,
	runtime: &SessionRuntimeView,
	control: QueueControl,
) -> Button {
	let (slot, label, command) = match control {
		QueueControl::Steering => (
			Control::QueueSteering,
			format!("Steer {}", delivery_label(&runtime.queue.steering)),
			UiCommand::SetQueueMode {
				session:   session.clone(),
				steering:  next_delivery(&runtime.queue.steering),
				follow_up: runtime.queue.follow_up.clone(),
				interrupt: runtime.queue.interrupt.clone(),
			},
		),
		QueueControl::FollowUp => (
			Control::QueueFollowUp,
			format!("Follow-up {}", delivery_label(&runtime.queue.follow_up)),
			UiCommand::SetQueueMode {
				session:   session.clone(),
				steering:  runtime.queue.steering.clone(),
				follow_up: next_delivery(&runtime.queue.follow_up),
				interrupt: runtime.queue.interrupt.clone(),
			},
		),
		QueueControl::Interrupt => (
			Control::QueueInterrupt,
			format!("Interrupt {}", interrupt_label(&runtime.queue.interrupt)),
			UiCommand::SetQueueMode {
				session:   session.clone(),
				steering:  runtime.queue.steering.clone(),
				follow_up: runtime.queue.follow_up.clone(),
				interrupt: next_interrupt(&runtime.queue.interrupt),
			},
		),
	};
	Button::labelled(format!("queue-mode-{}", slot.name()), control_owner(slot), label)
		.icon(Icon::Mode)
		.on_click(act::click(command))
}

fn next_delivery(delivery: &QueueDelivery) -> QueueDelivery {
	match delivery {
		QueueDelivery::Immediate => QueueDelivery::Queued,
		QueueDelivery::Queued => QueueDelivery::Disabled,
		QueueDelivery::Disabled | QueueDelivery::Unknown(_) => QueueDelivery::Immediate,
	}
}

fn delivery_label(delivery: &QueueDelivery) -> &str {
	match delivery {
		QueueDelivery::Immediate => "immediate",
		QueueDelivery::Queued => "queued",
		QueueDelivery::Disabled => "off",
		QueueDelivery::Unknown(value) => value,
	}
}

fn next_interrupt(mode: &InterruptMode) -> InterruptMode {
	match mode {
		InterruptMode::AbortThenSend => InterruptMode::Queue,
		InterruptMode::Queue => InterruptMode::Disabled,
		InterruptMode::Disabled | InterruptMode::Unknown(_) => InterruptMode::AbortThenSend,
	}
}

fn interrupt_label(mode: &InterruptMode) -> &str {
	match mode {
		InterruptMode::AbortThenSend => "abort then send",
		InterruptMode::Queue => "queue",
		InterruptMode::Disabled => "off",
		InterruptMode::Unknown(value) => value,
	}
}

fn attachment_limit_reason(store: &Store, runtime: Option<&SessionRuntimeView>) -> Option<String> {
	let (_, draft) = logic::selected_draft(store)?;
	let maximum = runtime?.prompt_constraints.max_attachments?;
	(draft.attachments.len() >= maximum)
		.then(|| format!("The active provider allows at most {maximum} attachments"))
}

pub fn capability_reason(store: &Store, capability: Capability) -> Option<String> {
	if !store.connection.is_connected() {
		return Some("Reconnect to use this control".to_owned());
	}
	match store.replica.capabilities.get(&capability) {
		Some(CapabilityStatus::Available) => None,
		Some(CapabilityStatus::Unavailable { reason }) => Some(reason.clone()),
		Some(CapabilityStatus::UnknownUntilAttached) | None => {
			Some("The attached host has not advertised this capability".to_owned())
		},
	}
}
