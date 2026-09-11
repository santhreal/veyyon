//! Themes settings page body rendering (§5.9, §6.9).
//!
//! Two listings, and they answer to different owners. The appearance rows are
//! this build's bundled themes: the window draws one of them, so the choice is
//! the window's and reaches the colours with no host in the loop. The rows
//! under them are the themes a host reported for the agent it runs, which the
//! window only relays.
//!
//! An appearance row previews on hover because a theme is judged by looking at
//! it. The pointer arriving draws the whole window in that appearance and the
//! pointer leaving puts the chosen one back, so nothing is committed by
//! reading the page.

use veyyon_desktop_kit::{Badge, Button, ButtonSize, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div,
};

use crate::{
	Intent, ShellView,
	controls::{Availability, ControlStates},
	model::AppearanceChoice,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
	tokens::ThemeLibrary,
};

/// Renders the Themes page: the appearances this build draws, then the themes
/// the host reported.
pub fn render_themes_page(
	state: &SettingsState,
	appearance: &AppearanceChoice,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap))
		.children(appearance_rows(appearance, geometry, tokens, cx));

	let Some(themes_view) = &state.themes else {
		return container.child(empty_state_row("No themes reported by host.", geometry, tokens));
	};

	if themes_view.themes.is_empty() {
		return container.child(empty_state_row("No themes reported by host.", geometry, tokens));
	}

	let av = controls.availability(&SurfaceId::ThemeSelector);

	for theme in &themes_view.themes {
		let is_selected = theme.id == themes_view.current;
		let theme_id_str = theme.id.clone();

		let control_el = if is_selected {
			Badge::new("Active", TintRole::Done).into_any_element()
		} else {
			Button::new(ElementId::Name(format!("theme-opt-{}", theme.id).into()), "Select")
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
					view.dispatch(Intent::SelectTheme(theme_id_str.clone()), cx);
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

/// One row per bundled appearance, in the order the build loaded them.
///
/// Empty when no library is installed, which is a window rendered from a
/// fixture rather than opened by the binary: there is nothing to preview and
/// nothing to select, and drawing a row that selects nothing would be worse
/// than drawing none.
fn appearance_rows(
	choice: &AppearanceChoice,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Vec<Stateful<Div>> {
	let Some(library) = cx.try_global::<ThemeLibrary>() else {
		return Vec::new();
	};
	library
		.themes()
		.iter()
		.map(|theme| {
			let appearance = theme.appearance.clone();
			let control = if choice.chosen() == appearance {
				Badge::new("Active", TintRole::Done).into_any_element()
			} else {
				let selected = appearance.clone();
				Button::new(ElementId::Name(format!("appearance-opt-{appearance}").into()), "Select")
					.size(ButtonSize::Small)
					.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
						view.dispatch(Intent::SelectAppearance(selected.clone()), cx);
					}))
					.into_any_element()
			};
			// The hover listener is what registers the row's hit rect: an id
			// alone paints no box to test the pointer against.
			let previewed = appearance.clone();
			div()
				.id(ElementId::Name(format!("appearance-row-{appearance}").into()))
				.w_full()
				.on_hover(cx.listener(move |view, hovered: &bool, _w, cx| {
					let wanted = hovered.then(|| previewed.clone());
					view.dispatch(Intent::PreviewAppearance(wanted), cx);
				}))
				.child(setting_row(
					&theme.name,
					Some(&describe(&appearance)),
					control,
					&Availability::Enabled,
					geometry,
					tokens,
				))
		})
		.collect()
}

/// What an appearance row states under its name.
fn describe(appearance: &str) -> String {
	let mut described = String::with_capacity(appearance.len() + 12);
	let mut characters = appearance.chars();
	if let Some(first) = characters.next() {
		described.extend(first.to_uppercase());
		described.push_str(characters.as_str());
	}
	described.push_str(" appearance");
	described
}
