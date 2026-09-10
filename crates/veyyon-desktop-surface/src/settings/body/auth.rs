//! Authentication settings page body rendering (§5.9, §8.12).

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, ButtonVariant, TintRole, TokenSet,
	input::{Editor, TextField},
};
use veyyon_desktop_model::AuthFlowState;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, Entity, ParentElement, Styled, div};

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
	secret: Option<Entity<Editor>>,
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

			let open_btn = Button::new("auth-open-url-btn", "Open Browser")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::OpenAuthUrl(url_for_open.clone()), cx);
				}));

			let cancel_btn = Button::new("auth-cancel-btn", "Cancel")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow, cx);
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
			// The field is the retained editor or there is no field: a
			// primitive built from a value keeps no keystroke, so a submit
			// that read one back would send an empty secret (§8.25, §9.3).
			let text_field = secret.map(|editor| TextField::new("auth-secret-input", editor));

			let submit_btn = Button::new("auth-submit-secret-btn", "Submit")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.submit_pending_secret(cx);
				}));

			let cancel_btn = Button::new("auth-cancel-btn", "Cancel")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow, cx);
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

			if let Some(text_field) = text_field {
				container = container.child(setting_row(
					"Secret Input",
					None,
					text_field,
					&av,
					geometry,
					tokens,
				));
			}
		},
		AuthFlowState::Failed => {
			let retry_btn = Button::new("auth-retry-btn", "Retry")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryAuthFlow, cx);
				}));

			let cancel_btn = Button::new("auth-cancel-btn", "Dismiss")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::CancelAuthFlow, cx);
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
			let retry_btn = Button::new("auth-retry-btn", "Start Flow")
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::RetryAuthFlow, cx);
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
