//! The Appearance page: the palette the window draws with, dark, light or the
//! system's, and the installed themes, one chosen for a dark ground and one
//! for a light ground.
//!
//! Resting the pointer on a palette's row draws the window in it; leaving the
//! row draws the chosen one again. Only Use chooses, and the choice is
//! recorded in the window's store, which a relaunch opens in.

use serde_json::Value;
use veyyon_desktop_model::{HostAction, SurfaceId, ThemeView};
use veyyon_desktop_ui::{
	controls::ButtonVariant,
	icons::{Icon, IconName},
	theme::{ActiveTheme, Appearance, Palette, Theme, size, space},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, div, prelude::*};

use super::{
	Page, SettingsView, targets,
	widgets::{heading, local_button, note, row, title},
};

impl SettingsView {
	pub(super) fn appearance(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let page = div()
			.child(title(Page::Appearance.label(), Page::Appearance.description(), &palette))
			.child(heading("Window", &palette))
			.children(self.palettes(&palette, cx));
		let Some(mut themes) = self.app.read(cx).store().domains.themes.clone() else {
			return page
				.child(note("Loading themes from the host…", &palette))
				.into_any_element();
		};
		self.held.themes(&mut themes);
		let (dark, light): (Vec<&ThemeView>, Vec<&ThemeView>) =
			themes.themes.iter().partition(|theme| theme.dark);
		let dark_rows = ground(&dark, &themes.dark, true, &palette, cx);
		let light_rows = ground(&light, &themes.light, false, &palette, cx);
		page
			.child(heading("Dark ground", &palette))
			.children(dark_rows)
			.child(heading("Light ground", &palette))
			.children(light_rows)
			.into_any_element()
	}

	/// A row per window palette, the system's first. Hovering a row draws the
	/// window in its palette; Use chooses it.
	fn palettes(&self, palette: &Palette, cx: &Context<Self>) -> Vec<AnyElement> {
		let chosen = self.app.read(cx).chosen_appearance();
		let system = Appearance::from_system(cx.window_appearance());
		let choices = [
			(None, "system", "Match system", format!("Follows the system, {} now", name(system))),
			(Some(Appearance::Dark), "dark", "Dark", "The dark palette".to_owned()),
			(Some(Appearance::Light), "light", "Light", "The light palette".to_owned()),
		];
		choices
			.into_iter()
			.map(|(choice, id, label, description)| {
				let control = if choice == chosen {
					Icon::new(IconName::Check)
						.size(size::ICON)
						.color(palette.accent.base)
						.into_any_element()
				} else {
					local_button(
						SharedString::from(format!("use-appearance-{id}")),
						"Use",
						ButtonVariant::Ghost,
						cx.listener(move |this, _, _, cx| this.choose_appearance(choice, cx)),
					)
				};
				let shown = choice.unwrap_or(system);
				let entry = div()
					.id(SharedString::from(format!("appearance-{id}")))
					.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
						if *hovered {
							this.preview_appearance(Some(shown), cx);
						} else if this.previewing == Some(shown) {
							this.preview_appearance(None, cx);
						}
					}))
					.child(row(
						SharedString::from(format!("appearance-row-{id}")),
						label,
						Some(description.into()),
						div().pr(space::S1).child(control).into_any_element(),
						palette,
					));
				targets::target(("settings.control", format!("appearance-{id}")), entry)
			})
			.collect()
	}

	/// Draws the window in `appearance` while the pointer rests on its row,
	/// or in the chosen appearance again when `appearance` is `None`.
	pub(super) fn preview_appearance(
		&mut self,
		appearance: Option<Appearance>,
		cx: &mut Context<Self>,
	) {
		if self.previewing == appearance {
			return;
		}
		self.previewing = appearance;
		let drawn = appearance.unwrap_or_else(|| self.app.read(cx).window_appearance(cx));
		self.draw_in(drawn, cx);
	}

	/// Chooses `appearance` for the window, or the system's when `None`,
	/// and draws the window in it.
	fn choose_appearance(&mut self, appearance: Option<Appearance>, cx: &mut Context<Self>) {
		self
			.app
			.update(cx, |app, cx| app.choose_appearance(appearance, cx));
		self.previewing = None;
		let drawn = self.app.read(cx).window_appearance(cx);
		self.draw_in(drawn, cx);
		cx.notify();
	}

	/// Installs the palette of `appearance` and redraws every view in it.
	fn draw_in(&mut self, appearance: Appearance, cx: &mut Context<Self>) {
		if cx.theme().appearance == appearance {
			return;
		}
		match Theme::install(appearance, cx) {
			Ok(()) => cx.refresh_windows(),
			Err(error) => {
				self.failure = Some(error.to_string().into());
				cx.notify();
			},
		}
	}
}

const fn name(appearance: Appearance) -> &'static str {
	match appearance {
		Appearance::Dark => "dark",
		Appearance::Light => "light",
	}
}

/// A row per theme of one ground; choosing one writes `theme.dark` or
/// `theme.light` and reloads the list.
fn ground(
	themes: &[&ThemeView],
	chosen: &str,
	dark: bool,
	palette: &Palette,
	cx: &Context<SettingsView>,
) -> Vec<AnyElement> {
	if themes.is_empty() {
		return vec![note("No themes for this ground", palette)];
	}
	themes
		.iter()
		.map(|theme| {
			let control = if theme.id == chosen {
				Icon::new(IconName::Check)
					.size(size::ICON)
					.color(palette.accent.base)
					.into_any_element()
			} else {
				let key = if dark { "theme.dark" } else { "theme.light" };
				let id = theme.id.clone();
				local_button(
					SharedString::from(format!("use-theme-{}-{dark}", theme.id)),
					"Use",
					ButtonVariant::Ghost,
					cx.listener(move |this, _, _, cx| {
						let value = Value::String(id.clone());
						this.send(
							HostAction::SetSetting { key: key.to_owned(), value },
							SurfaceId::ThemeSelector,
							cx,
						);
						this.send(HostAction::LoadThemes, SurfaceId::ThemeSelector, cx);
					}),
				)
			};
			row(
				SharedString::from(format!("theme-{}-{dark}", theme.id)),
				theme.name.clone(),
				None,
				div().pr(space::S1).child(control).into_any_element(),
				palette,
			)
		})
		.collect()
}
