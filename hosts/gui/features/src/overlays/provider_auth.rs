//! Provider authentication phases with request-bound controls.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AuthFlowState, ProviderId, RemoteData},
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, space},
	ui::{Banner, Button, Empty, Fill, Icon, Sheet, Spinner, Tone, text},
};

use super::state::owner_of;
use crate::act;

pub fn render(
	store: &Store,
	provider: &ProviderId,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let sheet_owner = owner_of(&format!("provider-auth:{provider}"));
	let close_owner = owner_of(&format!("provider-auth:{provider}:close"));
	let theme = Theme::get(cx);
	let body = body(store, provider, field, cx);
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
		// The provider writes the instructions and the device URL, so the flow
		// is what scrolls: the heading and its Close stay drawn, and a long
		// instruction never pushes the sign-in controls out of the panel.
		.body(scroll, body)
		.into_any_element()
}

fn body(store: &Store, provider: &ProviderId, field: &Entity<Editor>, cx: &mut App) -> AnyElement {
	let auth = match &store.replica.auth {
		RemoteData::Unrequested | RemoteData::Loading { .. } => {
			return loading(provider, "loading");
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
			let button = labelled(provider, "start", "Start sign in");
			content.child(enabled(
				button
					.fill(Fill::Solid)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::StartProviderAuth(provider.clone()))),
				connected,
			))
		},
		Some(AuthFlowState::Starting) => content
			.child(loading(provider, "starting"))
			.child(cancel(provider)),
		Some(AuthFlowState::AwaitingBrowser { url, launch_url, instructions }) => {
			let open_url = launch_url.as_ref().unwrap_or(url);
			let copy = labelled(provider, "copy-url", "Copy link");
			let open = labelled(provider, "open-url", "Open browser");
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
						.child(cancel(provider))
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
			.child(cancel(provider)),
		Some(AuthFlowState::AwaitingCallback) => content
			.child(text::body("Waiting for the provider callback", &theme))
			.child(loading(provider, "callback"))
			.child(cancel(provider)),
		Some(AuthFlowState::Succeeded) => {
			let done = labelled(provider, "done", "Done");
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
			let retry = labelled(provider, "retry", "Retry");
			content
				.child(Banner::failure("Sign in failed").detail(message.clone()))
				.child(
					div()
						.flex()
						.justify_end()
						.gap(px(space::SNUG))
						.child(cancel(provider))
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
			let restart = labelled(provider, "restart", "Start again");
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

fn labelled(provider: &ProviderId, id: &str, label: &str) -> Button {
	let owner = owner_of(&format!("provider-auth:{provider}:{id}"));
	Button::labelled(format!("provider-auth-{id}"), owner, label.to_owned())
}

fn cancel(provider: &ProviderId) -> Button {
	let button = labelled(provider, "cancel", "Cancel");
	button.on_click(act::click(UiCommand::CancelAuthFlow { provider: provider.clone() }))
}

fn loading(provider: &ProviderId, id: &str) -> AnyElement {
	let owner = owner_of(&format!("provider-auth:{provider}:{id}"));
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
