//! Authentication settings page body rendering (§5.9, §8.12).

use std::sync::{Arc, Mutex};

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, ButtonVariant, TintRole, TokenSet, input::TextField,
};
use veyyon_desktop_model::AuthFlowState;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::Availability,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row, setting_row_with_secondary},
	},
};

/// Renders the Authentication workflow state machine page rows.
pub fn render_auth_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	let Some(flow) = &state.auth_flow else {
		return container.child(empty_state_row("No active authentication flow.", geometry, tokens));
	};

	let av = Availability::Enabled;
	let provider = flow.provider.clone();

	match flow.state {
		AuthFlowState::AwaitingBrowser => {
			let url_str = flow.url.clone().unwrap_or_default();
			let url_for_open = url_str;

			let open_btn = Button::new("Open Browser")
				.id("auth-open-url-btn")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::OpenAuthUrl(url_for_open.clone()));
					cx.notify();
				}));

			let cancel_btn = Button::new("Cancel")
				.id("auth-cancel-btn")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow);
					cx.notify();
				}));

			let desc = flow
				.prompt
				.as_deref()
				.or(flow.message.as_deref())
				.unwrap_or("Complete authorization in your web browser");

			container = container.child(setting_row_with_secondary(
				&format!("Authorize {provider}"),
				Some(desc),
				open_btn,
				Some(cancel_btn),
				&av,
				geometry,
				tokens,
			));
		},
		AuthFlowState::AwaitingSecret => {
			let secret_buffer = Arc::new(Mutex::new(String::new()));
			let sec_buf = secret_buffer.clone();

			let text_field = TextField::new("")
				.id("auth-secret-input")
				.placeholder("API key or code")
				.on_change(move |text, _win, _app| {
					if let Ok(mut buf) = sec_buf.lock() {
						*buf = text.to_string();
					}
				});

			let prov_clone = provider.clone();
			let sec_for_submit = secret_buffer;
			let submit_btn = Button::new("Submit")
				.id("auth-submit-secret-btn")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					let secret = sec_for_submit.lock().map(|b| b.clone()).unwrap_or_default();
					view.dispatch(Intent::SubmitAuthSecret { provider: prov_clone.clone(), secret });
					cx.notify();
				}));

			let cancel_btn = Button::new("Cancel")
				.id("auth-cancel-btn")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow);
					cx.notify();
				}));

			let desc = flow
				.prompt
				.as_deref()
				.unwrap_or("Enter secret or authorization token");

			container = container.child(setting_row_with_secondary(
				&format!("Secret Key for {provider}"),
				Some(desc),
				submit_btn,
				Some(cancel_btn),
				&av,
				geometry,
				tokens,
			));

			container =
				container.child(setting_row("Secret Input", None, text_field, &av, geometry, tokens));
		},
		AuthFlowState::Failed => {
			let retry_btn = Button::new("Retry")
				.id("auth-retry-btn")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryAuthFlow);
					cx.notify();
				}));

			let cancel_btn = Button::new("Dismiss")
				.id("auth-cancel-btn")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow);
					cx.notify();
				}));

			let desc = flow
				.message
				.as_deref()
				.unwrap_or("Authentication request failed.");

			container = container.child(setting_row_with_secondary(
				&format!("Failed: {provider}"),
				Some(desc),
				retry_btn,
				Some(cancel_btn),
				&av,
				geometry,
				tokens,
			));
		},
		AuthFlowState::Cancelled => {
			let retry_btn = Button::new("Start Flow")
				.id("auth-retry-btn")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryAuthFlow);
					cx.notify();
				}));

			container = container.child(setting_row(
				&format!("Cancelled: {provider}"),
				flow.message.as_deref().or(Some("Flow was cancelled")),
				retry_btn,
				&av,
				geometry,
				tokens,
			));
		},
		AuthFlowState::Completed => {
			let badge = Badge::new("Connected", TintRole::Done);
			container = container.child(setting_row(
				&format!("Authenticated: {provider}"),
				flow.message.as_deref().or(Some("Authorization verified")),
				badge,
				&av,
				geometry,
				tokens,
			));
		},
	}

	container
}
