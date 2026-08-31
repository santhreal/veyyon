//! Composed editor, controls, context meter, and runtime actions.

use gpui::{
	App, Div, Entity, InteractiveElement, MouseButton, ParentElement, Styled, Window, div, px,
};
use veyyon_gui_core::{
	Store,
	model::{Capability, SessionRuntimeView, TurnState},
	navigation::Draft,
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, layout, space},
	ui::{Badge, Button, ComposerChrome, Fill, Icon, Meter, Tone, text},
};

use super::{
	banners, chips, completions, controls, logic,
	state::{Control, control_owner},
};
use crate::act;

pub fn render(store: &Store, field: &Entity<Editor>, window: &mut Window, cx: &mut App) -> Div {
	main_composer(store, field, window, cx)
}

pub fn main_composer(
	store: &Store,
	field: &Entity<Editor>,
	_window: &mut Window,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let runtime = logic::active_runtime(store);
	let draft = logic::selected_draft(store).map(|(_, draft)| draft);
	let required_decision = required_decision(store);
	let gate = logic::GateContext {
		connected: store.connection.is_connected(),
		provider_error: provider_error(store),
		invalid_reason: runtime
			.and_then(|runtime| runtime.prompt_constraints.validation_error.as_deref()),
		max_characters: runtime.and_then(|runtime| runtime.prompt_constraints.max_characters),
		max_attachments: runtime.and_then(|runtime| runtime.prompt_constraints.max_attachments),
		required_decision,
	};
	let blocked = logic::blocked(draft, gate);
	let action = logic::primary_action(runtime);
	let pending = logic::submission_pending(draft);
	let controls = controls::composer_controls(store, runtime);
	let footer = composer_footer(store, runtime, draft, action, blocked.as_ref(), pending, &theme);
	let mut chrome = ComposerChrome::new(field.clone())
		.banner(banners::pending_context(store))
		.context(chips::context_chips(store, cx))
		.toolbar(controls)
		.footer(footer)
		.expanded(true);
	if let Some(menu) = completions::completion_menu(store, cx) {
		chrome = chrome.banner(menu);
	}
	let focus_field = field.clone();
	div()
		.w_full()
		.max_w(px(layout::reading()))
		.mx_auto()
		.on_mouse_down(MouseButton::Left, move |_, window, cx| {
			Editor::focus(&focus_field, window, cx);
		})
		.child(chrome)
}

// The footer reads eight independent pieces of already-borrowed state.
#[allow(clippy::too_many_arguments)]
fn composer_footer(
	store: &Store,
	runtime: Option<&SessionRuntimeView>,
	draft: Option<&Draft>,
	action: logic::PrimaryAction,
	blocked: Option<&logic::Blocked<'_>>,
	pending: bool,
	theme: &Theme,
) -> Div {
	let mut footer = div()
		.flex()
		.flex_1()
		.min_w(px(0.0))
		.items_center()
		.gap(px(space::X8));
	if let Some((filled, figure)) = logic::context_fraction(runtime) {
		footer = footer
			.child(
				div()
					.flex_1()
					.min_w(px(0.0))
					.max_w(px(layout::measure()))
					.child(Meter::new(filled).bare()),
			)
			.child(Badge::new(figure).exact().bare());
	}
	let reason = primary_disabled_reason(store, runtime, action, blocked, pending);
	let status = reason.clone().unwrap_or_else(|| {
		format!("Enter to {} · Shift+Enter for a new line", action.label().to_lowercase())
	});
	footer = footer
		.child(text::meta(status, theme))
		.child(text::spacer());
	let background_reason = if draft.is_none() {
		"Select a conversation before sending in background".to_owned()
	} else {
		controls::capability_reason(store, Capability::BackgroundSubmission)
			.unwrap_or_else(|| "Background submission is unavailable".to_owned())
	};
	let background =
		Button::new("send-background", control_owner(Control::Background), Icon::Background)
			.tip("Send in background")
			.disabled(background_reason);
	footer
		.child(background)
		.child(primary_button(store, runtime, action, reason))
}

fn primary_button(
	store: &Store,
	runtime: Option<&SessionRuntimeView>,
	action: logic::PrimaryAction,
	disabled: Option<String>,
) -> Button {
	let icon = if action == logic::PrimaryAction::Abort {
		Icon::Stop
	} else {
		Icon::Send
	};
	let mut button = Button::new("composer-primary", control_owner(Control::Primary), icon)
		.label(action.label())
		.fill(Fill::Solid)
		.tone(if action == logic::PrimaryAction::Abort {
			Tone::Danger
		} else {
			Tone::Accent
		});
	if let Some(session) = store.frontend.selected_session.as_ref() {
		button = button.on_click(act::click(action.command(session)));
	}
	if let Some(reason) = disabled {
		button = button.disabled(reason);
	}
	if action == logic::PrimaryAction::Abort
		&& matches!(runtime.map(|runtime| &runtime.turn), Some(TurnState::Aborting))
	{
		button = button.disabled("Abort is already pending");
	}
	button
}

fn primary_disabled_reason(
	store: &Store,
	runtime: Option<&SessionRuntimeView>,
	action: logic::PrimaryAction,
	blocked: Option<&logic::Blocked<'_>>,
	pending: bool,
) -> Option<String> {
	if action == logic::PrimaryAction::Abort {
		if !store.connection.is_connected() {
			return Some("Reconnect before aborting the running turn".to_owned());
		}
		if runtime.is_none() {
			return Some("Runtime state is unavailable; abort cannot be confirmed".to_owned());
		}
		return None;
	}
	if pending {
		return Some("Wait for the pending composer action to finish".to_owned());
	}
	blocked.map(logic::Blocked::message)
}

fn required_decision(store: &Store) -> Option<&'static str> {
	if store
		.replica
		.interactions
		.readable()
		.is_some_and(|items| !items.value.is_empty())
	{
		return Some("Answer the pending request before sending another message");
	}
	if store.replica.plan.readable().is_some_and(|plan| {
		matches!(&plan.value, veyyon_gui_core::model::PlanState::Active { approval: Some(_), .. })
	}) {
		return Some("Review the pending plan before sending another message");
	}
	None
}

fn provider_error(store: &Store) -> Option<&str> {
	let provider = logic::active_runtime(store)?.provider.as_ref()?;
	store
		.replica
		.providers
		.readable()?
		.value
		.iter()
		.find(|candidate| &candidate.id == provider)?
		.error
		.as_deref()
}
