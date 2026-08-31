//! Appearance preferences and truthful theme preview controls.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{CommandState, ThemeState, Versioned},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Theme, size, space},
	ui::{Badge, Banner, Field, Fill, Group, Icon, Size, Tabs, Tone, text},
};

use super::remote;
use crate::act;

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
	// The designed sizes, not what they currently render at: a choice read
	// through the scale moves every time it is used, so it stops matching the
	// preference it set and no tab reads as selected.
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
		.child(theme_registry(store, cx))
		.into_any_element()
}

fn theme_registry(store: &Store, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.themes,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading themes",
			empty:       "No profile themes",
			empty_note:  "The built-in appearance remains active.",
			detached:    "Profile themes are not loaded",
			unavailable: "Themes are unavailable",
		},
		UiCommand::LoadThemes,
		|versioned: &Versioned<ThemeState>, mutable, cx| {
			theme_rows(store, &versioned.value, mutable, cx)
		},
		cx,
	)
}

fn theme_rows(store: &Store, themes: &ThemeState, mutable: bool, cx: &mut App) -> AnyElement {
	if themes.available.is_empty() {
		return veyyon_gui_kit::ui::Empty::new("No profile themes")
			.note("The built-in appearance remains active.")
			.into_any_element();
	}
	let _theme = Theme::get(cx);
	let state = store.command_state(&CommandTarget::Themes);
	let mut stack = text::stack(space::BASE);
	if let CommandState::Failed { message, .. } = &state {
		stack = stack.child(Banner::failure("Theme change failed").detail(message.clone()));
	}
	let mut group =
		Group::new("Themes").note("Preview changes only this window until Use theme succeeds.");
	for option in &themes.available {
		let previewing = store.frontend.theme_preview.as_deref() == Some(option.id.as_str());
		let selected = themes.selected.as_deref() == Some(option.id.as_str());
		let mut actions = div().flex().flex_wrap().items_center().gap(px(space::SNUG));
		if previewing {
			actions = actions
				.child(Badge::new("Preview").tone(Tone::Accent))
				.child(
					crate::settings::controls::button(format!("cancel-theme-{}", option.id), "Cancel")
						.fill(Fill::Ghost)
						.size(Size::Small)
						.on_click(act::click(UiCommand::CancelThemePreview)),
				);
		} else {
			actions = actions.child(
				crate::settings::controls::button(format!("preview-theme-{}", option.id), "Preview")
					.fill(Fill::Ghost)
					.size(Size::Small)
					.on_click(act::click(UiCommand::PreviewTheme(option.id.clone()))),
			);
		}
		if selected {
			actions = actions.child(Badge::new("Current").icon(Icon::Check).tone(Tone::Ok));
		}
		let mut use_btn =
			crate::settings::controls::button(format!("use-theme-{}", option.id), "Use theme")
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.size(Size::Small);
		if matches!(state, CommandState::Pending { .. }) {
			use_btn = use_btn.disabled("Theme change in progress");
		} else if !mutable {
			use_btn = use_btn.disabled("Themes are read-only");
		} else {
			use_btn = use_btn.on_click(act::click(UiCommand::SetTheme(option.id.clone())));
		}
		actions = actions.child(use_btn);
		group = group.child(
			Field::new(option.name.clone())
				.stacked()
				.note(if option.dark {
					"Dark theme"
				} else {
					"Light theme"
				})
				.child(actions),
		);
	}
	stack.child(group).into_any_element()
}
