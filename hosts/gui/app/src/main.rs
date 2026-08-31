//! The window.
//!
//! One process, one window, one view. This file does the four things a desktop
//! app has to do before it can draw: resolve the fonts it asked for down to
//! ones the machine has, install the palette, install the keymaps, and open
//! a window whose frame the app draws itself.
//!
//! Window lifecycle: ⌘W closes the window and leaves the process running with
//! the menu bar up; reopening from the dock restores the recorded shell state
//! and window geometry clamped to the display.

#[cfg(test)]
mod a_chime_and_a_system_notice_are_two_separate_settings;
#[cfg(test)]
mod a_palette_row_hands_the_keyboard_to_what_it_drew;
#[cfg(test)]
mod a_relaunch_restores_spaces_or_rejects_stale_or_missing_sessions;
#[cfg(test)]
mod a_reopened_palette_starts_on_an_empty_field;
#[cfg(test)]
mod a_request_raised_by_an_event_leaves_on_the_same_pass;
#[cfg(test)]
mod a_typed_secret_leaves_the_field_only_on_submit;
mod bridge;
mod chrome;
#[cfg(test)]
mod every_filter_the_window_holds_has_a_field;
mod handles;
mod launch;
pub mod menus;
pub mod notice;
mod shell;
#[cfg(test)]
mod the_keyboard_reaches_every_route;
#[cfg(test)]
mod the_menu_bar_says_what_is_reachable_right_now;
#[cfg(test)]
mod the_window_draws_the_preferences_it_holds;
#[cfg(test)]
mod the_window_holds_a_terminal_grid_rather_than_a_message_about_one;
#[cfg(test)]
mod the_window_opens_inside_the_display;
#[cfg(test)]
mod the_window_reopens_with_its_recorded_state;
mod transport;
pub mod window_state;

use gpui::{
	App, AppContext, Bounds, Pixels, Size, TextRenderingMode, TitlebarOptions, WindowBounds,
	WindowDecorations, WindowHandle, WindowKind, WindowOptions, point, px, size,
};
use gpui_platform::application;
use veyyon_gui_core::host::HostEvent;
use veyyon_gui_features::act;
use veyyon_gui_kit::{
	input,
	theme::{Appearance, MONO_CANDIDATES, MONO_FAMILY, Theme, UI_CANDIDATES, UI_FAMILY},
};

/// The window's opening size, and the floor it may be dragged to.
pub(crate) const WIDTH: f32 = 1_320.0;
pub(crate) const HEIGHT: f32 = 880.0;
pub(crate) const MIN_WIDTH: f32 = 900.0;
pub(crate) const MIN_HEIGHT: f32 = 560.0;

/// How much of the display the window leaves around itself when it has to
/// shrink to fit one.
pub(crate) const MARGIN: f32 = 48.0;

/// State preserved across window closure for dock-icon reopen.
#[derive(Clone)]
pub struct ReopenState {
	pub shell:       gpui::Entity<shell::Shell>,
	pub last_bounds: Option<Bounds<Pixels>>,
}

impl gpui::Global for ReopenState {}

/// Where the window opens: the asked-for size, fitted to the display it opens
/// on, centred there.
pub(crate) fn opening(cx: &mut App) -> Bounds<Pixels> {
	let room = cx.primary_display().map(|display| display.bounds().size);
	Bounds::centered(None, fitted(room), cx)
}

/// The asked-for size, shrunk to the display it opens on, and never below the
/// size the window can be dragged to.
pub(crate) fn fitted(room: Option<Size<Pixels>>) -> Size<Pixels> {
	let Some(room) = room else {
		return size(px(WIDTH), px(HEIGHT));
	};
	size(
		px(WIDTH.min(f32::from(room.width) - MARGIN).max(MIN_WIDTH)),
		px(HEIGHT.min(f32::from(room.height) - MARGIN).max(MIN_HEIGHT)),
	)
}

/// Clamps window bounds into display room, maintaining minimum dimensions.
pub fn clamp_bounds(
	bounds: Bounds<Pixels>,
	room: Option<Size<Pixels>>,
	display_origin: Option<gpui::Point<Pixels>>,
) -> Bounds<Pixels> {
	let fitted_size = fitted(room);
	let width = bounds.size.width.min(fitted_size.width).max(px(MIN_WIDTH));
	let height = bounds
		.size
		.height
		.min(fitted_size.height)
		.max(px(MIN_HEIGHT));
	let (origin_x, origin_y) = if let (Some(room_size), Some(disp_orig)) = (room, display_origin) {
		let max_x = (disp_orig.x + room_size.width - width).max(disp_orig.x);
		let max_y = (disp_orig.y + room_size.height - height).max(disp_orig.y);
		(bounds.origin.x.max(disp_orig.x).min(max_x), bounds.origin.y.max(disp_orig.y).min(max_y))
	} else {
		(bounds.origin.x, bounds.origin.y)
	};
	Bounds::new(point(origin_x, origin_y), size(width, height))
}

/// Open the initial window with the given host events and bounds.
pub(crate) fn open_initial_window(
	events: Vec<HostEvent>,
	bounds: Bounds<Pixels>,
	cx: &mut App,
) -> WindowHandle<shell::Shell> {
	let options = WindowOptions {
		window_bounds: Some(WindowBounds::Windowed(bounds)),
		window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
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
		app_owns_titlebar_drag: true,
		app_id: Some("dev.veyyon.gui".to_owned()),
		..Default::default()
	};

	let mut shell_entity = None;
	let window = cx
		.open_window(options, |window, cx| {
			window.set_rem_size(px(16.0));
			let shell = cx.new(|cx| shell::Shell::with_events(events, window, cx));
			shell_entity = Some(shell.clone());
			shell
		})
		.expect("the platform must give the app a window");

	window
		.update(cx, |shell, window, cx| {
			window.activate_window();
			cx.activate(true);
			cx.set_menus(menus::app_menus(Some(&shell.store)));
		})
		.ok();

	if let Some(shell) = shell_entity {
		cx.set_global(ReopenState { shell, last_bounds: Some(bounds) });
	}

	window
}

/// Reopen a closed window restoring the retained shell and target bounds.
pub(crate) fn open_reopened_window(
	shell: gpui::Entity<shell::Shell>,
	bounds: Bounds<Pixels>,
	cx: &mut App,
) -> WindowHandle<shell::Shell> {
	let options = WindowOptions {
		window_bounds: Some(WindowBounds::Windowed(bounds)),
		window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
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
		app_owns_titlebar_drag: true,
		app_id: Some("dev.veyyon.gui".to_owned()),
		..Default::default()
	};

	let shell_entity = shell.clone();
	let window = cx
		.open_window(options, |window, _cx| {
			window.set_rem_size(px(16.0));
			shell_entity
		})
		.expect("the platform must give the app a window");

	window
		.update(cx, |shell, window, cx| {
			window.activate_window();
			cx.activate(true);
			cx.set_menus(menus::app_menus(Some(&shell.store)));
		})
		.ok();

	cx.set_global(ReopenState { shell, last_bounds: Some(bounds) });

	window
}

fn main() {
	let launch = match launch::Launch::parse(std::env::args().skip(1)) {
		Ok(launch) => launch,
		Err(error) => {
			eprintln!("{error}");
			std::process::exit(2);
		},
	};
	let app = application();

	app.on_reopen(|cx| {
		if cx.windows().is_empty()
			&& let Some(reopen) = cx.try_global::<ReopenState>()
		{
			let (shell, bounds) = (reopen.shell.clone(), reopen.last_bounds);
			let primary_display = cx.primary_display();
			let room = primary_display
				.as_ref()
				.map(|display| display.bounds().size);
			let display_origin = primary_display
				.as_ref()
				.map(|display| display.bounds().origin);
			let target_bounds = match bounds {
				Some(b) => clamp_bounds(b, room, display_origin),
				None => opening(cx),
			};
			open_reopened_window(shell, target_bounds, cx);
		}
	});

	app.run(move |cx: &mut App| {
		install_fonts(cx);
		cx.set_text_rendering_mode(TextRenderingMode::Grayscale);
		Theme::set(Appearance::Dark, cx);

		notice::init(cx);
		menus::init(cx);
		cx.bind_keys(act::bindings());
		cx.bind_keys(input::keys::bindings());
		menus::bind_keys(cx);
		cx.set_menus(menus::app_menus(None));

		let bounds = opening(cx);

		#[cfg(debug_assertions)]
		let events = launch.events;
		#[cfg(not(debug_assertions))]
		let events = Vec::new();

		open_initial_window(events, bounds, cx);

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
