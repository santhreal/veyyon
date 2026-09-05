//! General settings page body rendering (§5.9).

use veyyon_desktop_kit::{ColorRole, TextRamp, TokenSet, Tooltip};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		body::general_control::setting_control,
		row::{empty_state_row, setting_row_with_secondary},
	},
};

/// Renders the General configuration settings page rows.
pub fn render_general_page(
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

	if state.settings.is_empty() {
		return container.child(empty_state_row("No settings reported by host.", geometry, tokens));
	}

	let mut rendered_count = 0;

	for (key, entry) in &state.settings {
		if entry.hidden {
			continue;
		}

		let field_id = SurfaceId::SettingsField(key.clone());
		let av = controls.availability(&field_id);

		let control_el = setting_control(key, entry, cx);

		let is_modified = entry.value != entry.default;
		let secondary_el = if is_modified {
			let key_clone = key.clone();
			let reset_btn = div()
				.id(ElementId::Name(format!("reset-{key}").into()))
				.cursor_pointer()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.hover(move |s| s.text_color(tokens.color(ColorRole::Foreground)))
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::ResetSetting(key_clone.clone()));
					cx.notify();
				}))
				.child("Reset");
			// The tooltip states what the reset restores, so the operator
			// reads the default before discarding the value.
			let default = entry
				.default
				.as_str()
				.map_or_else(|| entry.default.to_string(), str::to_owned);
			Some(
				Tooltip::new(format!("Default: {default}"), reset_btn)
					.group(format!("reset-tip-{key}"))
					.into_any_element(),
			)
		} else {
			None
		};

		container = container.child(setting_row_with_secondary(
			entry.label.as_deref().unwrap_or(key),
			entry.description.as_deref(),
			control_el,
			secondary_el,
			&av,
			geometry,
			tokens,
		));
		rendered_count += 1;
	}

	if rendered_count == 0 {
		container =
			container.child(empty_state_row("No configurable settings available.", geometry, tokens));
	}

	container
}
