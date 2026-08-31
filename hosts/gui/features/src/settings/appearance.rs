//! Appearance preferences, theme library selection, and hover preview controls.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ThemeState, Versioned},
};
use veyyon_gui_kit::{
	theme::{Appearance, Theme, entries as library_entries, resolve_theme, size, space},
	ui::{Badge, Banner, Field, Fill, Group, Icon, Size, Tabs, Tone, text},
};

use super::remote;
use crate::act;

/// Render the complete appearance settings page.
pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let preferences = &store.frontend.preferences;
	let modes = Tabs::new("appearance-mode")
		.tab(
			crate::settings::controls::tab("Dark", preferences.dark)
				.icon(Icon::Dark)
				.on_click(act::click(UiCommand::SetDarkAppearance(true))),
		)
		.tab(
			crate::settings::controls::tab("Light", !preferences.dark)
				.icon(Icon::Light)
				.on_click(act::click(UiCommand::SetDarkAppearance(false))),
		);

	let mut reduced =
		crate::settings::controls::switch("reduced-motion", preferences.reduced_motion);
	reduced = reduced.on_click(act::click(UiCommand::SetReducedMotion(!preferences.reduced_motion)));

	let font_px = preferences.font_size_milli_px;
	let mut fonts = Tabs::new("font-size");
	for points in size::CHOICES_PX {
		let milli = (points * 1_000.0) as u16;
		fonts = fonts.tab(
			crate::settings::controls::tab(format!("{points:.0}"), font_px == milli)
				.on_click(act::click(UiCommand::SetFontSize { milli_px: milli })),
		);
	}

	text::stack(space::LOOSE)
		.child(text::title("Appearance", &theme))
		.child(
			Group::new("Window")
				.child(
					Field::new("Appearance")
						.stacked()
						.note("Choose the window's light or dark palette.")
						.child(modes),
				)
				.child(
					Field::new("Interface text")
						.stacked()
						.note("Sets the base size every row, control and icon is measured from.")
						.child(fonts),
				)
				.child(
					Field::new("Reduce motion")
						.stacked()
						.note("Preserves every state change without spatial animation.")
						.child(reduced),
				),
		)
		.child(theme_library_group(store, cx))
		.child(theme_registry(store, cx))
		.into_any_element()
}

/// Renders built-in theme library selection with hover preview and press
/// persistence.
fn theme_library_group(store: &Store, cx: &mut App) -> AnyElement {
	let _theme = Theme::get(cx);
	let selected_id = store.frontend.preferences.theme.as_deref();
	let appearance = if store.frontend.preferences.dark {
		Appearance::Dark
	} else {
		Appearance::Light
	};
	let report = resolve_theme(selected_id, appearance);
	let current_id = report.entry.id;

	let mut stack = text::stack(space::BASE);

	if let Some(refused_name) = &report.refused {
		stack = stack.child(Banner::notice("Theme fallback active").detail(format!(
			"Unknown theme `{refused_name}` was refused; using default `{}`.",
			report.entry.name
		)));
	}
	let mut group = Group::new("Built-in Themes")
		.note("Hover a theme to preview its palette live. Press to persist.");

	for entry in library_entries() {
		let is_current = entry.id == current_id;
		let is_previewing = store.frontend.theme_preview.as_deref() == Some(entry.id);

		let preview_id = entry.id.to_string();
		let select_id = entry.id.to_string();

		let mut actions = div().flex().flex_wrap().items_center().gap(px(space::SNUG));

		// Visual swatches for the theme.
		let swatches = div()
			.flex()
			.items_center()
			.gap(px(space::TIGHT))
			.child(
				div()
					.size(px(size::overline()))
					.rounded_full()
					.bg(entry.theme.ground)
					.border_1()
					.border_color(entry.theme.stroke),
			)
			.child(
				div()
					.size(px(size::overline()))
					.rounded_full()
					.bg(entry.theme.accent),
			)
			.child(
				div()
					.size(px(size::overline()))
					.rounded_full()
					.bg(entry.theme.text),
			);

		actions = actions.child(swatches);

		if is_previewing {
			actions = actions
				.child(Badge::new("Previewing").tone(Tone::Accent))
				.child(
					crate::settings::controls::button(format!("cancel-preview-{}", entry.id), "Cancel")
						.fill(Fill::Ghost)
						.size(Size::Small)
						.on_click(act::click(UiCommand::CancelThemePreview)),
				);
		}

		if is_current {
			actions = actions.child(Badge::new("Active").icon(Icon::Check).tone(Tone::Ok));
		}

		let use_btn = crate::settings::controls::button(
			format!("select-theme-{}", entry.id),
			if is_current { "Selected" } else { "Select" },
		)
		.fill(if is_current {
			Fill::Tinted
		} else {
			Fill::Ghost
		})
		.tone(if is_current { Tone::Ok } else { Tone::Accent })
		.size(Size::Small)
		.on_click(act::click(UiCommand::SetTheme(select_id.clone())));

		actions = actions.child(use_btn);

		let row_interactive =
			div()
				.id(format!("theme-row-{}", entry.id))
				.on_hover(move |over: &bool, window, cx| {
					if *over {
						act::run(UiCommand::PreviewTheme(preview_id.clone()), window, cx);
					} else {
						act::run(UiCommand::CancelThemePreview, window, cx);
					}
				});

		let field_content = Field::new(entry.name)
			.stacked()
			.note(match entry.appearance {
				veyyon_gui_kit::theme::Appearance::Dark => "Dark palette",
				veyyon_gui_kit::theme::Appearance::Light => "Light palette",
			})
			.child(actions);

		let row_element = row_interactive.child(field_content).into_any_element();

		group = group.child(row_element);
	}

	stack.child(group).into_any_element()
}

fn theme_registry(store: &Store, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.themes,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading profile themes",
			empty:       "No profile themes",
			empty_note:  "The window draws from its own palettes.",
			detached:    "Profile themes are not loaded",
			unavailable: "Themes are unavailable",
		},
		UiCommand::LoadThemes,
		|versioned: &Versioned<ThemeState>, _mutable, cx| theme_rows(&versioned.value, cx),
		cx,
	)
}

/// Lists the themes installed in the profile. A profile theme carries a name
/// and an appearance, not a palette, so the window cannot draw one: these rows
/// state what the terminal interface uses and offer no selection.
fn theme_rows(themes: &ThemeState, cx: &mut App) -> AnyElement {
	if themes.available.is_empty() {
		return div().into_any_element();
	}
	let _theme = Theme::get(cx);
	let mut group = Group::new("Profile Themes")
		.note("Installed in your profile and applied to the terminal interface.");
	for option in &themes.available {
		let mut row = Field::new(option.name.clone())
			.stacked()
			.note(if option.dark {
				"Dark theme"
			} else {
				"Light theme"
			});
		if themes.selected.as_deref() == Some(option.id.as_str()) {
			row = row.child(Badge::new("Terminal").icon(Icon::Check).tone(Tone::Ok));
		}
		group = group.child(row);
	}
	text::stack(space::BASE).child(group).into_any_element()
}
