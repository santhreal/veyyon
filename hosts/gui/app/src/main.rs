//! The window.
//!
//! One process, one window, one view. This file does the four things a desktop
//! app has to do before it can draw: resolve the fonts it asked for down to
//! ones the machine has, install the palette, install the keymap, and open a
//! window whose frame the app draws itself.
//!
//! No engine is attached, and nothing here pretends one is. The window opens on
//! the directory the process was started in, keeps the conversations that are
//! written in it, and says where a reply would be. An engine arrives as a
//! producer of messages behind `state::moves`, and no surface changes shape
//! when it does.

mod composer;
mod input;
mod keys;
mod motion;
mod palette;
mod settings;
mod shell;
mod sidebar;
mod state;
#[cfg(test)]
mod the_keyboard_reaches_every_route;
mod theme;
mod transcript;
mod ui;

use std::time::Duration;

use gpui::{
	App, AppContext, Bounds, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowDecorations,
	WindowKind, WindowOptions, actions, point, px, size,
};
use gpui_platform::application;

use crate::{
	state::model::Appearance,
	theme::{MONO_CANDIDATES, MONO_FAMILY, Theme, UI_CANDIDATES, UI_FAMILY},
};

actions!(veyyon, [Quit, HideApp]);

/// The window's opening size, and the floor it may be dragged to.
const WIDTH: f32 = 1_320.0;
const HEIGHT: f32 = 880.0;
const MIN_WIDTH: f32 = 900.0;
const MIN_HEIGHT: f32 = 560.0;

fn main() {
	// A capture or a smoke run needs the window to close itself. Nothing else
	// reads the command line yet.
	let exit_after = std::env::args()
		.skip_while(|argument| argument != "--exit-after")
		.nth(1)
		.and_then(|value| value.parse::<u64>().ok());

	application().run(move |cx: &mut App| {
		install_fonts(cx);
		Theme::set(Appearance::Dark, cx);
		cx.bind_keys(keys::bindings());
		cx.set_menus(menus());
		cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
		cx.on_action(|_: &HideApp, cx: &mut App| cx.hide());

		let bounds = Bounds::centered(None, size(px(WIDTH), px(HEIGHT)), cx);
		let options = WindowOptions {
			window_bounds: Some(WindowBounds::Windowed(bounds)),
			window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
			// The app draws its own titlebar, so the platform's is asked for
			// transparent rather than removed: on macOS the traffic lights stay
			// where every other application puts them, and their inset is what
			// the titlebar leaves room for.
			titlebar: Some(TitlebarOptions {
				title:                  None,
				appears_transparent:    true,
				traffic_light_position: Some(point(px(14.0), px(14.0))),
			}),
			window_background: Theme::get(cx).window_background(),
			window_decorations: Some(if cfg!(target_os = "macos") {
				WindowDecorations::Server
			} else {
				WindowDecorations::Client
			}),
			kind: WindowKind::Normal,
			// The titlebar this app draws moves the window itself, so AppKit is
			// told not to: otherwise it both drags the window and delays every
			// titlebar click while it waits to see a double.
			app_owns_titlebar_drag: true,
			app_id: Some("dev.veyyon.gui".to_owned()),
			..Default::default()
		};

		let window = cx
			.open_window(options, |window, cx| {
				// Nothing in the window is sized in rem, so this is only the
				// base gpui resolves its own defaults against.
				window.set_rem_size(px(16.0));
				cx.new(|cx| shell::Shell::new(window, cx))
			})
			.expect("the platform must give the app a window");

		window
			.update(cx, |_, window, cx| {
				window.activate_window();
				cx.activate(true);
			})
			.ok();

		if let Some(after) = exit_after {
			cx.spawn(async move |cx| {
				cx.background_executor()
					.timer(Duration::from_millis(after))
					.await;
				cx.update(|cx| cx.quit());
			})
			.detach();
		}
	});
}

/// Resolve the families the app asks for down to families the machine has, and
/// install the first that is present.
///
/// gpui takes one family name, not a list, so a missing font would be an empty
/// window rather than a fallback. This asks the text system what it has and
/// rewrites the theme's two names before anything is drawn.
fn install_fonts(cx: &mut App) {
	let available = cx.text_system().all_font_names();
	let present = |name: &str| available.iter().any(|family| family == name);

	let ui = UI_CANDIDATES
		.into_iter()
		.find(|name| present(name))
		.unwrap_or(UI_FAMILY);
	let mono = MONO_CANDIDATES
		.into_iter()
		.find(|name| present(name))
		.unwrap_or(MONO_FAMILY);
	theme::set_families(ui, mono);
}

/// The menu bar. macOS shows it; everywhere else it is where the application's
/// own accelerators are declared for the platform.
fn menus() -> Vec<Menu> {
	vec![
		Menu::new("veyyon").items([
			MenuItem::action("Settings", shell::OpenSettings),
			MenuItem::separator(),
			MenuItem::action("Hide", HideApp),
			MenuItem::action("Quit", Quit),
		]),
		Menu::new("Conversation").items([
			MenuItem::action("New conversation", shell::NewSession),
			MenuItem::action("Next conversation", shell::CycleNext),
			MenuItem::action("Previous conversation", shell::CyclePrev),
			MenuItem::separator(),
			MenuItem::action("Delete this conversation", shell::DeleteSession),
		]),
		Menu::new("View").items([
			MenuItem::action("Commands", shell::OpenPalette),
			MenuItem::action("Conversation list", shell::ToggleSidebar),
			MenuItem::separator(),
			MenuItem::action("Flip light and dark", shell::FlipAppearance),
		]),
	]
}
