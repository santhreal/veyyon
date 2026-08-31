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

#[cfg(test)]
mod a_palette_row_hands_the_keyboard_to_what_it_drew;
#[cfg(test)]
mod a_reopened_palette_starts_on_an_empty_field;
#[cfg(test)]
mod a_typed_secret_leaves_the_field_only_on_submit;
mod bridge;
mod chrome;
#[cfg(test)]
mod every_filter_the_window_holds_has_a_field;
mod handles;
mod launch;
mod shell;
#[cfg(test)]
mod the_keyboard_reaches_every_route;
#[cfg(test)]
mod the_window_draws_the_preferences_it_holds;
#[cfg(test)]
mod the_window_opens_inside_the_display;

use gpui::{
	App, AppContext, Bounds, Menu, MenuItem, Pixels, Size, TextRenderingMode, TitlebarOptions,
	WindowBounds, WindowDecorations, WindowKind, WindowOptions, actions, point, px, size,
};
use gpui_platform::application;
use veyyon_gui_core::{
	UiCommand,
	navigation::{Overlay, PaletteMode, Route, SettingsPage},
};
use veyyon_gui_features::act::{self, Do};
use veyyon_gui_kit::{
	input,
	theme::{Appearance, MONO_CANDIDATES, MONO_FAMILY, Theme, UI_CANDIDATES, UI_FAMILY},
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
	let launch = match launch::Launch::parse(std::env::args().skip(1)) {
		Ok(launch) => launch,
		Err(error) => {
			eprintln!("{error}");
			std::process::exit(2);
		},
	};
	application().run(move |cx: &mut App| {
		install_fonts(cx);
		// Subpixel rendering puts a blue fringe down the left of every stem and
		// an orange one down the right, up to 140 parts in 255 of colour on text
		// that is meant to be grey. The platform chooses it on Linux and on
		// Windows and never on macOS, so asking for grayscale both drops the
		// fringe and makes one window out of the three.
		cx.set_text_rendering_mode(TextRenderingMode::Grayscale);
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

		#[cfg(debug_assertions)]
		let events = launch.events;
		#[cfg(not(debug_assertions))]
		let events = Vec::new();

		let window = cx
			.open_window(options, |window, cx| {
				// Nothing in the window is sized in rem, so this is only the
				// base gpui resolves its own defaults against.
				window.set_rem_size(px(16.0));
				cx.new(|cx| shell::Shell::with_events(events, window, cx))
			})
			.expect("the platform must give the app a window");

		window
			.update(cx, |_, window, cx| {
				window.activate_window();
				cx.activate(true);
			})
			.ok();

		if let Some(after) = launch.exit_after {
			cx.spawn(async move |cx| {
				cx.background_executor().timer(after).await;
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
	let row = |name: &'static str, command: UiCommand| MenuItem::action(name, Do(command));
	vec![
		Menu::new("veyyon").items([
			row("Settings", UiCommand::Navigate(Route::Settings(SettingsPage::Appearance))),
			MenuItem::separator(),
			MenuItem::action("Hide", HideApp),
			row("Quit", UiCommand::QuitWindow),
		]),
		Menu::new("Conversation").items([
			row("New Session", UiCommand::CreateSession { workspace: None, parent: None }),
			row("Next Session", UiCommand::CycleSession { forward: true }),
			row("Previous Session", UiCommand::CycleSession { forward: false }),
			MenuItem::separator(),
			row("Close Overlay", UiCommand::CloseTopOverlay),
		]),
		Menu::new("View").items([
			row(
				"Command Palette",
				UiCommand::OpenOverlay(Overlay::CommandPalette { mode: PaletteMode::Commands }),
			),
			row("Toggle Sidebar", UiCommand::ToggleSidebar),
			row("Toggle Bottom Dock", UiCommand::ToggleBottomDock),
			row("Toggle Inspector", UiCommand::ToggleInspector),
			MenuItem::separator(),
			row("Toggle Dark Theme", UiCommand::SetDarkAppearance(true)),
		]),
	]
}
