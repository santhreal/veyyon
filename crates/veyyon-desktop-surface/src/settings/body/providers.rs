//! Providers settings page body rendering (§5.9).

use veyyon_desktop_kit::{Badge, Button, ButtonSize, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ElementId, IntoElement, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
};

/// Renders the AI model providers configuration page rows.
pub fn render_providers_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	if state.providers.is_empty() {
		return container.child(empty_state_row("No model providers configured.", geometry, tokens));
	}

	let shell_state = cx.entity().read(cx).state();

	for provider in &state.providers {
		let provider_id = provider.id.clone();
		let av = shell_state
			.controls
			.availability(&SurfaceId::ProviderAuthStartButton(provider_id.clone()));

		let control_el = if provider.authenticated {
			Badge::new("Connected", TintRole::Done).into_any_element()
		} else {
			Button::new("Sign in")
				.id(ElementId::Name(format!("auth-btn-{}", provider.id).into()))
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::StartProviderAuth(provider_id.clone()));
					cx.notify();
				}))
				.into_any_element()
		};

		container = container.child(setting_row(
			&provider.name,
			Some(&provider.id),
			control_el,
			&av,
			geometry,
			tokens,
		));
	}

	container
}
