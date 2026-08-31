//! Ask, select, multiselect, confirm, input, editor, and URL requests.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		InteractionId, InteractionKind, InteractionOption, InteractionRequest, InteractionResponse,
	},
	navigation::InteractionDraft,
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, space},
	ui::{Banner, Button, Empty, Fill, Icon, Row, Sheet, Spinner, Tone, text},
};

use super::{
	interaction::{self, RequestState},
	state::OverlayState,
};
use crate::act;

pub fn render(
	store: &Store,
	id: &InteractionId,
	field: &Entity<Editor>,
	note: &Entity<Editor>,
	state: &mut OverlayState,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let draft = store
		.frontend
		.interaction_drafts
		.get(id)
		.cloned()
		.unwrap_or_default();
	sync(field, &draft.text, cx);
	sync(note, &draft.note, cx);
	let Some(sheet_owner) = state.owner(format!("question:{id}")) else {
		return Banner::failure("Question unavailable").into_any_element();
	};
	let (title, body) = match interaction::request(store, id) {
		RequestState::Loading => {
			let Some(owner) = state.owner(format!("question:{id}:loading")) else {
				return Banner::failure("Question unavailable").into_any_element();
			};
			("Question", Spinner::new(owner, Icon::Running).into_any_element())
		},
		RequestState::Missing => (
			"Question",
			Empty::new("This request has ended")
				.icon(Icon::Notice)
				.into_any_element(),
		),
		RequestState::Error { message, .. } => (
			"Question unavailable",
			Banner::failure("Question unavailable")
				.detail(message.to_owned())
				.into_any_element(),
		),
		RequestState::Stale(request, reason) => {
			(title(request), form(store, request, &draft, field, note, Some(reason), state, cx))
		},
		RequestState::Ready(request) => {
			(title(request), form(store, request, &draft, field, note, None, state, cx))
		},
	};
	let theme = Theme::get(cx);
	Sheet::new("question-dialog", sheet_owner, open)
		.centred()
		.on_dismiss(act::click(UiCommand::CancelInteraction {
			interaction: id.clone(),
			timed_out:   false,
		}))
		.child(text::heading(title.to_owned(), &theme))
		.child(body)
		.into_any_element()
}

fn sync(field: &Entity<Editor>, value: &str, cx: &mut App) {
	field.update(cx, |editor, cx| editor.set_text(value, value.len(), cx));
}

// The form borrows request, draft, two fields and the overlay state separately.
#[allow(clippy::too_many_arguments)]
fn form(
	store: &Store,
	request: &InteractionRequest,
	draft: &InteractionDraft,
	field: &Entity<Editor>,
	note: &Entity<Editor>,
	stale: Option<String>,
	state: &mut OverlayState,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let connected = store.connection.is_connected() && stale.is_none() && draft.submitting.is_none();
	let mut content = div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.children(stale.map(|reason| Banner::notice("Response paused").detail(reason)))
		.children(
			draft
				.validation_error
				.as_ref()
				.map(|error| Banner::failure("Check the response").detail(error.clone())),
		);

	match &request.kind {
		InteractionKind::Ask { question, options, multiple, .. } => {
			content = content
				.child(text::body(question.clone(), &theme))
				.child(options_list(request, options, *multiple, draft, state));
			if options.is_empty() {
				content = content.child(field.clone());
			}
			content = content.child(note.clone()).child(actions(
				request,
				connected,
				InteractionResponse::SubmitAsk {
					selected: selected(draft, *multiple),
					custom:   nonempty(&draft.text),
					note:     nonempty(&draft.note),
				},
				state,
			));
		},
		InteractionKind::Select { options, multiple, .. } => {
			content = content
				.child(options_list(request, options, *multiple, draft, state))
				.child(actions(
					request,
					connected && (*multiple || draft.selected.is_some()),
					InteractionResponse::Select { selected: selected(draft, *multiple) },
					state,
				));
		},
		InteractionKind::Confirm { message, .. } => {
			content = content
				.child(text::body(message.clone(), &theme))
				.child(confirm_actions(request, connected, state));
		},
		InteractionKind::Input { secret, .. } => {
			if *secret {
				content =
					content.child(Banner::failure("Secure input unavailable").detail(
						"A zeroizable secret field is required before this value can be submitted",
					));
			} else {
				content = content.child(field.clone()).child(actions(
					request,
					connected,
					InteractionResponse::Text(draft.text.clone()),
					state,
				));
			}
		},
		InteractionKind::Editor { .. } => {
			content = content.child(field.clone()).child(actions(
				request,
				connected,
				InteractionResponse::Text(draft.text.clone()),
				state,
			));
		},
		InteractionKind::OpenUrl { url, .. } => {
			let Some(button) = button(state, request, "open-url", "Open link") else {
				return Banner::failure("Question controls unavailable").into_any_element();
			};
			content = content
				.child(text::body(url.clone(), &theme))
				.child(enabled(
					button
						.fill(Fill::Solid)
						.tone(Tone::Accent)
						.on_click(run_url(request.id.clone(), url.clone())),
					connected,
				));
		},
		InteractionKind::Approval { .. } => {
			content = content.child(Banner::failure("This request belongs in the approval dialog"));
		},
	}
	content.into_any_element()
}

fn options_list(
	request: &InteractionRequest,
	options: &[InteractionOption],
	multiple: bool,
	draft: &InteractionDraft,
	state: &mut OverlayState,
) -> AnyElement {
	if options.is_empty() {
		return Empty::new("No options were provided")
			.icon(Icon::Notice)
			.into_any_element();
	}
	let mut list = div().flex().flex_col().gap(px(space::ROWS));
	for (index, option) in options.iter().enumerate() {
		let Some(owner) = state.owner(format!("question:{}:option:{index}", request.id)) else {
			return Banner::failure("Question options unavailable").into_any_element();
		};
		let checked = if multiple {
			draft.checked.contains(&index)
		} else {
			draft.selected == Some(index)
		};
		let command = if multiple {
			UiCommand::ToggleInteractionOption { interaction: request.id.clone(), index }
		} else {
			UiCommand::SelectInteractionOption { interaction: request.id.clone(), index }
		};
		let mut row = Row::new(format!("question-option-{index}"), owner, option.label.clone())
			.gutter(true)
			.selected(checked)
			.on_click(act::click(command));
		if let Some(detail) = option.description.as_ref().or(option.preview.as_ref()) {
			row = row.note(detail.clone());
		}
		list = list.child(row);
	}
	list.into_any_element()
}

fn actions(
	request: &InteractionRequest,
	is_enabled: bool,
	response: InteractionResponse,
	state: &mut OverlayState,
) -> gpui::Div {
	let cancel = button(state, request, "cancel", "Cancel");
	let submit = button(state, request, "submit", "Submit");
	div()
		.flex()
		.items_center()
		.justify_end()
		.gap(px(space::SNUG))
		.children(cancel.map(|button| {
			button.on_click(act::click(UiCommand::CancelInteraction {
				interaction: request.id.clone(),
				timed_out:   false,
			}))
		}))
		.children(submit.map(|button| {
			enabled(
				button
					.fill(Fill::Solid)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::SubmitInteraction {
						interaction: request.id.clone(),
						response,
					})),
				is_enabled,
			)
		}))
}

fn confirm_actions(
	request: &InteractionRequest,
	is_enabled: bool,
	state: &mut OverlayState,
) -> gpui::Div {
	div()
		.flex()
		.items_center()
		.justify_end()
		.gap(px(space::SNUG))
		.children(confirm_button(request, "No", false, is_enabled, Tone::Muted, state))
		.children(confirm_button(request, "Yes", true, is_enabled, Tone::Accent, state))
}

fn confirm_button(
	request: &InteractionRequest,
	label: &str,
	value: bool,
	is_enabled: bool,
	tone: Tone,
	state: &mut OverlayState,
) -> Option<Button> {
	Some(enabled(
		button(state, request, &format!("confirm-{value}"), label)?
			.fill(Fill::Solid)
			.tone(tone)
			.on_click(act::click(UiCommand::SubmitInteraction {
				interaction: request.id.clone(),
				response:    InteractionResponse::Confirm(value),
			})),
		is_enabled,
	))
}

fn button(
	state: &mut OverlayState,
	request: &InteractionRequest,
	id: &str,
	label: &str,
) -> Option<Button> {
	let owner = state.owner(format!("question:{}:{id}", request.id))?;
	Some(Button::labelled(format!("question-{id}"), owner, label.to_owned()))
}

fn enabled(button: Button, enabled: bool) -> Button {
	if enabled {
		button
	} else {
		button.disabled("Reconnect before responding")
	}
}

fn selected(draft: &InteractionDraft, multiple: bool) -> Vec<usize> {
	if multiple {
		draft.checked.iter().copied().collect()
	} else {
		draft.selected.into_iter().collect()
	}
}

fn nonempty(value: &str) -> Option<String> {
	(!value.trim().is_empty()).then(|| value.to_owned())
}

fn title(request: &InteractionRequest) -> &str {
	match &request.kind {
		InteractionKind::Ask { header, .. } => header.as_deref().unwrap_or("Question"),
		InteractionKind::Select { title, .. }
		| InteractionKind::Confirm { title, .. }
		| InteractionKind::Input { title, .. }
		| InteractionKind::Editor { title, .. }
		| InteractionKind::OpenUrl { title, .. } => title,
		InteractionKind::Approval { .. } => "Approval",
	}
}

fn run_url(
	interaction: InteractionId,
	url: String,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut App) + 'static {
	move |_, window, cx| {
		act::run(UiCommand::OpenExternal(url.clone()), window, cx);
		act::run(
			UiCommand::SubmitInteraction {
				interaction: interaction.clone(),
				response:    InteractionResponse::OpenedUrl,
			},
			window,
			cx,
		);
	}
}
