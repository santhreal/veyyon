//! Providers settings page body rendering (§5.9).

use veyyon_desktop_kit::{Badge, Button, ButtonSize, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, ElementId, IntoElement, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::{Availability, ControlStates},
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
};

/// Renders the AI model providers configuration page rows.
pub fn render_providers_page(
	state: &SettingsState,
	controls: &ControlStates,
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

	let prov_av = controls.availability(&SurfaceId::SettingsField("providers".to_string()));
	for provider in &state.providers {
		let provider_id = provider.id.clone();
		let auth_av = controls.availability(&SurfaceId::ProviderAuthStartButton(provider_id.clone()));
		let av = if matches!(prov_av, Availability::Unavailable { .. } | Availability::Pending) {
			prov_av.clone()
		} else {
			auth_av
		};
		let control_el = if provider.authenticated {
			Badge::new("Connected", TintRole::Done).into_any_element()
		} else {
			Button::new(ElementId::Name(format!("auth-btn-{}", provider.id).into()), "Sign in")
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::StartProviderAuth(provider_id.clone()), cx);
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
