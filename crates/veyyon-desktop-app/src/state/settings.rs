//! What the settings view keeps in the window's own store: the appearance the
//! window draws in, which a relaunch comes back in.

use veyyon_desktop_ui::theme::Appearance;
use veyyon_gpui::App;

use super::AppState;

impl AppState {
	/// The appearance chosen for the window, `None` while it follows the
	/// system. A recorded name other than `light` is the dark appearance.
	pub fn chosen_appearance(&self) -> Option<Appearance> {
		self
			.store
			.persisted
			.shell
			.appearance
			.as_deref()
			.map(|name| {
				if name == "light" {
					Appearance::Light
				} else {
					Appearance::Dark
				}
			})
	}

	/// The appearance the window draws in: the one chosen, or the system's.
	pub fn window_appearance(&self, cx: &App) -> Appearance {
		self
			.chosen_appearance()
			.unwrap_or_else(|| Appearance::from_system(cx.window_appearance()))
	}

	/// Records `appearance` as the window's, or `None` to follow the system.
	/// The window writes it with the rest of its store.
	pub fn choose_appearance(&mut self, appearance: Option<Appearance>) {
		self.store.persisted.shell.appearance = appearance.map(|appearance| {
			match appearance {
				Appearance::Dark => "dark",
				Appearance::Light => "light",
			}
			.to_owned()
		});
	}
}
