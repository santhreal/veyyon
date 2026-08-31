//! Provider authentication phases with request-bound controls.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AuthFlowState, ProviderId, RemoteData},
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, space},
	ui::{Banner, Button, Empty, Fill, Icon, Sheet, Spinner, Tone, text},
};

use super::state::OverlayState;
use crate::act;

pub fn render(
	store: &Store,
	provider: &ProviderId,
	field: &Entity<Editor>,
	state: &mut OverlayState,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let Some(sheet_owner) = state.owner(format!("provider-auth:{provider}")) else {
		return Banner::failure("Provider sign in unavailable").into_any_element();
	};
	let Some(close_owner) = state.owner(format!("provider-auth:{provider}:close")) else {
		return Banner::failure("Provider sign in unavailable").into_any_element();
	};
	let theme = Theme::get(cx);
	let body = body(store, provider, field, state, cx);
	Sheet::new("provider-auth", sheet_owner, open)
		.centred()
		.on_dismiss(act::click(UiCommand::CancelAuthFlow { provider: provider.clone() }))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::BASE))
				.child(
					text::heading("Connect provider", &theme)
						.flex_1()
						.min_w(px(0.0)),
				)
				.child(
					Button::new("close-provider-auth", close_owner, Icon::Close)
						.tip("Cancel provider sign in")
						.on_click(act::click(UiCommand::CancelAuthFlow { provider: provider.clone() })),
				),
		)
		.child(body)
		.into_any_element()
}

fn body(
	store: &Store,
	provider: &ProviderId,
	field: &Entity<Editor>,
	state: &mut OverlayState,
	cx: &mut App,
) -> AnyElement {
	let auth = match &store.replica.auth {
		RemoteData::Unrequested | RemoteData::Loading { .. } => {
			return loading(state, provider, "loading");
		},
		RemoteData::Empty => {
			return Empty::new("No authentication methods are available")
				.icon(Icon::Notice)
				.into_any_element();
		},
		RemoteData::Error { message, stale: None, .. } => {
			return Banner::failure("Authentication unavailable")
				.detail(message.clone())
				.into_any_element();
		},
		RemoteData::Ready(value)
		| RemoteData::Stale { value, .. }
		| RemoteData::Error { stale: Some(value), .. } => &value.value,
	};
	let provider_state = auth
		.providers
		.readable()
		.and_then(|providers| providers.iter().find(|candidate| &candidate.id == provider));
	let Some(provider_state) = provider_state else {
		return Empty::new("This provider is no longer available")
			.note("No other provider was selected")
			.icon(Icon::Notice)
			.into_any_element();
	};
	let connected = store.connection.is_connected();
	let theme = Theme::get(cx);
	let mut content = div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.child(text::label(provider_state.name.clone(), &theme));
	if !connected {
		content = content.child(Banner::notice("Sign in paused").detail("Reconnect to continue"));
	}
	content = match auth.flow.as_ref() {
		None => {
			let Some(button) = labelled(state, provider, "start", "Start sign in") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			content.child(enabled(
				button
					.fill(Fill::Solid)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::StartProviderAuth(provider.clone()))),
				connected,
			))
		},
		Some(AuthFlowState::Starting) => content
			.child(loading(state, provider, "starting"))
			.children(cancel(state, provider)),
		Some(AuthFlowState::AwaitingBrowser { url, launch_url, instructions }) => {
			let open_url = launch_url.as_ref().unwrap_or(url);
			let Some(copy) = labelled(state, provider, "copy-url", "Copy link") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			let Some(open) = labelled(state, provider, "open-url", "Open browser") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			content
				.children(
					instructions
						.as_ref()
						.map(|value| text::body(value.clone(), &theme)),
				)
				.child(text::mono(url.clone(), &theme))
				.child(
					div()
						.flex()
						.flex_wrap()
						.justify_end()
						.gap(px(space::SNUG))
						.children(cancel(state, provider))
						.child(copy.on_click(act::click(UiCommand::CopyText(url.clone()))))
						.child(enabled(
							open
								.fill(Fill::Solid)
								.tone(Tone::Accent)
								.on_click(act::click(UiCommand::OpenAuthUrl {
									provider: provider.clone(),
									url:      open_url.clone(),
								})),
							connected,
						)),
				)
		},
		Some(AuthFlowState::AwaitingSecretInput) => content
			.child(text::body("Paste the credential and press Enter.", &theme))
			.child(field.clone())
			.children(cancel(state, provider)),
		Some(AuthFlowState::AwaitingCallback) => content
			.child(text::body("Waiting for the provider callback", &theme))
			.child(loading(state, provider, "callback"))
			.children(cancel(state, provider)),
		Some(AuthFlowState::Succeeded) => {
			let Some(done) = labelled(state, provider, "done", "Done") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			content
				.child(Banner::new(Tone::Ok, "Provider connected"))
				.child(
					done
						.fill(Fill::Solid)
						.tone(Tone::Accent)
						.on_click(act::click(UiCommand::CloseTopOverlay)),
				)
		},
		Some(AuthFlowState::Failed { message }) => {
			let Some(retry) = labelled(state, provider, "retry", "Retry") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			content
				.child(Banner::failure("Sign in failed").detail(message.clone()))
				.child(
					div()
						.flex()
						.justify_end()
						.gap(px(space::SNUG))
						.children(cancel(state, provider))
						.child(enabled(
							retry
								.fill(Fill::Solid)
								.tone(Tone::Accent)
								.on_click(act::click(UiCommand::RetryAuthFlow {
									provider: provider.clone(),
								})),
							connected,
						)),
				)
		},
		Some(AuthFlowState::Cancelled) => {
			let Some(restart) = labelled(state, provider, "restart", "Start again") else {
				return Banner::failure("Sign in controls unavailable").into_any_element();
			};
			content
				.child(Banner::notice("Sign in cancelled"))
				.child(enabled(
					restart
						.on_click(act::click(UiCommand::RetryAuthFlow { provider: provider.clone() })),
					connected,
				))
		},
	};
	content.into_any_element()
}

fn labelled(
	state: &mut OverlayState,
	provider: &ProviderId,
	id: &str,
	label: &str,
) -> Option<Button> {
	let owner = state.owner(format!("provider-auth:{provider}:{id}"))?;
	Some(Button::labelled(format!("provider-auth-{id}"), owner, label.to_owned()))
}

fn cancel(state: &mut OverlayState, provider: &ProviderId) -> Option<Button> {
	let button = labelled(state, provider, "cancel", "Cancel")?;
	Some(button.on_click(act::click(UiCommand::CancelAuthFlow { provider: provider.clone() })))
}

fn loading(state: &mut OverlayState, provider: &ProviderId, id: &str) -> AnyElement {
	let Some(owner) = state.owner(format!("provider-auth:{provider}:{id}")) else {
		return Banner::failure("Sign in status unavailable").into_any_element();
	};
	div()
		.flex()
		.items_center()
		.justify_center()
		.py(px(space::LOOSE))
		.child(Spinner::new(owner, Icon::Running))
		.into_any_element()
}

fn enabled(button: Button, enabled: bool) -> Button {
	if enabled {
		button
	} else {
		button.disabled("Reconnect before starting sign in")
	}
}
