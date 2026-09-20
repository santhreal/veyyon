//! What a suite needs to type a slash command into a real window and read
//! back what it would run: the casings a command is typed in, the window the
//! intents are drained from, and the row the palette left selected.

use std::{cell::RefCell, path::Path, rc::Rc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{HeadlessSession, headless::RenderOptions};
use veyyon_desktop_surface::{
	Intent, Keymap, Overlay, PaletteState, ShellState, ShellView, install_tokens,
};
use veyyon_gpui::{App, AppContext, Entity, Window};

/// The spellings an operator reaches one command by: as written, shouted, and
/// with the shift key held over every other letter.
pub fn cases(spelling: &str) -> Vec<String> {
	let mut alternating = String::with_capacity(spelling.len());
	let mut upper = true;
	for character in spelling.chars() {
		if character.is_ascii_alphabetic() {
			alternating.push(if upper {
				character.to_ascii_uppercase()
			} else {
				character.to_ascii_lowercase()
			});
			upper = !upper;
		} else {
			alternating.push(character);
		}
	}
	vec![spelling.to_owned(), spelling.to_ascii_uppercase(), alternating]
}

/// A window over `state` that appends every intent it raises to `drained`.
pub fn shell(
	state: ShellState,
	drained: Rc<RefCell<Vec<Intent>>>,
) -> impl FnOnce(&mut Window, &mut App) -> Entity<ShellView> {
	move |_window, app| {
		let tokens = load_bundled_tokens().expect("tokens load");
		let theme = load_bundled_theme("dark").expect("theme loads");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		let view = app.new(|_| ShellView::new(installed, state));
		app.observe(&view, move |view, app| {
			let intents = view.update(app, |view, _| view.drain_intents());
			drained.borrow_mut().extend(intents);
		})
		.detach();
		view
	}
}

/// A window wide enough for the composer to keep its own measure.
pub fn options() -> RenderOptions {
	RenderOptions { width: 1180, height: 800, scale_factor: 1.0, ..RenderOptions::default() }
}

/// The row the palette would run for `typed`, by its title.
pub fn selected_for(session: &mut HeadlessSession<'_, ShellView>, typed: &str) -> Option<String> {
	session
		.update(|view, _, cx| view.set_composed("", cx))
		.expect("draft clears");
	session
		.update(|view, _, cx| view.set_composed(typed, cx))
		.expect("draft reaches the composer");
	session
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.and_then(PaletteState::selected_item)
				.map(|item| item.title.clone())
		})
		.expect("the palette answers what it would run")
}
