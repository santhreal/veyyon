//! Themes settings page body rendering (§5.9).

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

/// Renders the Themes selection page rows.
pub fn render_themes_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	let Some(themes_view) = &state.themes else {
		return container.child(empty_state_row("No themes reported by host.", geometry, tokens));
	};

	if themes_view.themes.is_empty() {
		return container.child(empty_state_row("No themes reported by host.", geometry, tokens));
	}

	let shell_state = cx.entity().read(cx).state();
	let av = shell_state.controls.availability(&SurfaceId::ThemeSelector);

	for theme in &themes_view.themes {
		let is_selected = theme.id == themes_view.current;
		let theme_id_str = theme.id.clone();

		let control_el = if is_selected {
			Badge::new("Active", TintRole::Done).into_any_element()
		} else {
			Button::new("Select")
				.id(ElementId::Name(format!("theme-opt-{}", theme.id).into()))
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::SelectTheme(theme_id_str.clone()));
					cx.notify();
				}))
				.into_any_element()
		};

		let desc = if theme.dark {
			"Dark ground theme"
		} else {
			"Light ground theme"
		};

		container =
			container.child(setting_row(&theme.name, Some(desc), control_el, &av, geometry, tokens));
	}

	container
}
