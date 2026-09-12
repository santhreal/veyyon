//! Theme choices use the shared picker, with window-local appearance previews.

use veyyon_desktop_kit::{Badge, Button, ButtonSize, Picker, SelectionState, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
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

/// The data adapter retains the distinction between local and host themes.
pub(crate) struct ThemeChoice {
	pub id:           String,
	pub button_id:    String,
	pub title:        String,
	pub description:  String,
	pub action:       Intent,
	pub preview:      Option<String>,
	pub active:       bool,
	pub availability: Availability,
}

impl ThemeChoice {
	pub const fn enabled(&self) -> bool {
		matches!(self.availability, Availability::Enabled | Availability::Unknown)
	}
}

pub(crate) fn theme_choices(
	state: &SettingsState,
	appearance: &AppearanceChoice,
	controls: &ControlStates,
	cx: &Context<ShellView>,
) -> Vec<ThemeChoice> {
	let mut rows = Vec::new();
	if let Some(library) = cx.try_global::<ThemeLibrary>() {
		rows.extend(library.themes().iter().map(|theme| ThemeChoice {
			id:           format!("appearance-row-{}", theme.appearance),
			button_id:    format!("appearance-opt-{}", theme.appearance),
			title:        theme.name.clone(),
			description:  describe(&theme.appearance),
			action:       Intent::SelectAppearance(theme.appearance.clone()),
			preview:      Some(theme.appearance.clone()),
			active:       appearance.chosen() == theme.appearance,
			availability: Availability::Enabled,
		}));
	}
	if let Some(themes) = &state.themes {
		let availability = controls.availability(&SurfaceId::ThemeSelector);
		rows.extend(themes.themes.iter().map(|theme| {
			ThemeChoice {
				id:           format!("theme-row-{}", theme.id),
				button_id:    format!("theme-opt-{}", theme.id),
				title:        theme.name.clone(),
				description:  if theme.dark {
					"Dark ground theme"
				} else {
					"Light ground theme"
				}
				.to_owned(),
				action:       Intent::SelectTheme(theme.id.clone()),
				preview:      None,
				active:       theme.id == themes.current,
				availability: availability.clone(),
			}
		}));
	}
	rows
}

pub fn render_themes_page(
	state: &SettingsState,
	appearance: &AppearanceChoice,
	controls: &ControlStates,
	scroll: &veyyon_gpui::ScrollHandle,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let rows = theme_choices(state, appearance, controls, cx);
	let picker = Picker::new(&rows, state.selected_row.unwrap_or(0));
	let mut container = div()
		.id("theme-picker-results")
		.track_scroll(scroll)
		.h_full()
		.min_h_0()
		.overflow_y_scroll()
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap));
	for (index, choice) in rows.iter().enumerate() {
		let control = if choice.active {
			Badge::new("Active", TintRole::Done).into_any_element()
		} else {
			let mut button = Button::new(ElementId::Name(choice.button_id.clone().into()), "Select")
				.size(ButtonSize::Small);
			if choice.enabled() {
				button = button.on_click(cx.listener(move |view, _, _, cx| {
					cx.stop_propagation();
					view.picker_pointer(index, true, cx);
				}));
			}
			button.into_any_element()
		};
		let description = choice.availability.reason().unwrap_or(&choice.description);
		let mut row = setting_row(
			&choice.title,
			Some(description),
			control,
			&choice.availability,
			geometry,
			tokens,
		)
		.id(("theme-choice", index))
		.bg(if picker.selection(index, ThemeChoice::enabled) == SelectionState::Selected {
			tokens.row_selected()
		} else {
			tokens.transparent()
		});
		if choice.enabled() {
			row = row.on_click(cx.listener(move |view, _, _, cx| {
				view.picker_pointer(index, true, cx);
			}));
		}
		container = container.child(
			div()
				.id(ElementId::Name(choice.id.clone().into()))
				.w_full()
				.flex_shrink_0()
				.on_hover(cx.listener(move |view, hovered: &bool, _, cx| {
					view.picker_preview(hovered.then_some(index), cx);
				}))
				.child(row),
		);
	}
	if state
		.themes
		.as_ref()
		.is_none_or(|themes| themes.themes.is_empty())
	{
		container = container.child(empty_state_row("No themes reported by host.", geometry, tokens));
	}
	div().h_full().min_h_0().child(container)
}

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
