//! The window.
//!
//! One process, one window, one view. This file does the four things a desktop
//! app has to do before it can draw: resolve the fonts it asked for down to
//! ones the machine has, install the palette, install the two keymaps, and open
//! a window whose frame the app draws itself.
//!
//! No engine is attached, and nothing here pretends one is. The window opens on
//! the directory the process was started in, keeps the conversations that are
//! written in it, and says where a reply would be. An engine arrives as a
//! producer of messages behind the store, and no surface changes shape when it
//! does.
//!
//! WHY THERE IS NO ACTION LIST HERE. Every menu row and every keystroke carries
//! [`Do`](veyyon_gui_features::act::Do) with the command it means, so the two
//! tables in `veyyon-gui-core` are the whole keymap and the whole menu bar. A
//! window-level action exists only for the two things that are not commands
//! against the store: hiding the application, which is the platform's, and
//! quitting, which the palette reaches through the command table.

mod chrome;
mod shell;
#[cfg(test)]
mod the_keyboard_reaches_every_route;
#[cfg(test)]
mod the_window_opens_inside_the_display;

use std::time::Duration;

use gpui::{
	App, AppContext, Bounds, Menu, MenuItem, Pixels, Size, TitlebarOptions, WindowBounds,
	WindowDecorations, WindowKind, WindowOptions, actions, point, px, size,
};
use gpui_platform::application;
use veyyon_gui_core::{
	command::Command,
	store::model::{Appearance, SettingsPage},
};
use veyyon_gui_features::act::{self, Do};
use veyyon_gui_kit::{
	input,
	theme::{MONO_CANDIDATES, MONO_FAMILY, Theme, UI_CANDIDATES, UI_FAMILY},
};

actions!(veyyon, [HideApp]);

/// The window's opening size, and the floor it may be dragged to.
const WIDTH: f32 = 1_320.0;
const HEIGHT: f32 = 880.0;
const MIN_WIDTH: f32 = 900.0;
const MIN_HEIGHT: f32 = 560.0;

/// How much of the display the window leaves around itself when it has to
/// shrink to fit one.
const MARGIN: f32 = 48.0;

/// Where the window opens: the asked-for size, fitted to the display it opens
/// on, centred there.
fn opening(cx: &mut App) -> Bounds<Pixels> {
	let room = cx.primary_display().map(|display| display.bounds().size);
	Bounds::centered(None, fitted(room), cx)
}

/// The asked-for size, shrunk to the display it opens on, and never below the
/// size the window can be dragged to.
///
/// A fixed size centred on a display smaller than itself hangs off every edge,
/// and what goes off the bottom edge is the composer: the one control the
/// window is for. Every laptop panel shorter than 880 points, and every small
/// virtual display, is that case. Below the minimum the size stops shrinking,
/// because a window smaller than that cannot lay out its own columns and the
/// platform will not let it be dragged there either.
fn fitted(room: Option<Size<Pixels>>) -> Size<Pixels> {
	let Some(room) = room else {
		return size(px(WIDTH), px(HEIGHT));
	};
	size(
		px(WIDTH.min(f32::from(room.width) - MARGIN).max(MIN_WIDTH)),
		px(HEIGHT.min(f32::from(room.height) - MARGIN).max(MIN_HEIGHT)),
	)
}

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
		// Two tables: what the window does, and what a caret does. Both are
		// installed here so a field cannot ship with half a keymap.
		cx.bind_keys(act::bindings());
		cx.bind_keys(input::keys::bindings());
		cx.set_menus(menus());
		cx.on_action(|_: &HideApp, cx: &mut App| cx.hide());

		let bounds = opening(cx);
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
	veyyon_gui_kit::theme::set_families(ui, mono);
}

/// The menu bar. macOS shows it; everywhere else it is where the application's
/// own accelerators are declared for the platform.
///
/// Every row is a command, so a menu row and its palette row and its chord are
/// the same thing said three ways, and the words come from the command itself.
fn menus() -> Vec<Menu> {
	let row = |command: Command| MenuItem::action(command.what(), Do(command));
	vec![
		Menu::new("veyyon").items([
			row(Command::OpenSettings(SettingsPage::Appearance)),
			MenuItem::separator(),
			MenuItem::action("Hide", HideApp),
			row(Command::Quit),
		]),
		Menu::new("Conversation").items([
			row(Command::NewSession),
			row(Command::CycleSession { forward: true }),
			row(Command::CycleSession { forward: false }),
			MenuItem::separator(),
			row(Command::DeleteSelected),
		]),
		Menu::new("View").items([
			row(Command::OpenPalette),
			row(Command::ToggleSidebar),
			MenuItem::separator(),
			row(Command::FlipAppearance),
			row(Command::StepTextSize { up: true }),
			row(Command::StepTextSize { up: false }),
		]),
	]
}
