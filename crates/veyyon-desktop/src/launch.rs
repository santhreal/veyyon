//! Opening a window, and what closing one means.
//!
//! One window is opened at launch and the same call opens the one a reopen
//! brings back, so what an operator gets from the dock is what a launch gives
//! them: the placement, the appearance and the session the last window left
//! behind (§8.10).
//!
//! Closing is two decisions, not one. The window goes, and the process either
//! stays up so something can bring a window back or ends with it. Only the
//! platform knows whether anything can reopen, so that answer is supplied at
//! the call site and the decision itself is a function of it.

use std::{cell::RefCell, process, rc::Rc};

use veyyon_desktop_model::PersistedState;
use veyyon_desktop_surface::{
	AppearanceChoice, ShellState, ShellView, ThemeLibrary, install_appearances,
};
use veyyon_gpui::{
	App, AppContext, Bounds, Pixels, Size, TitlebarOptions, WindowBounds, WindowHandle,
	WindowOptions, point, px,
};

use crate::{
	StartupBundle,
	state::{Keeper, StateDir, chosen_appearance, placement, report_rejections},
};

/// The window this process has open, or none while it has none.
///
/// A reopen and a token reload both need the window that is up now rather than
/// the one the closure was written against, so the handle travels in a slot
/// both read.
pub type WindowSlot = Rc<RefCell<Option<WindowHandle<ShellView>>>>;

/// What a window that was just closed leaves behind.
pub struct Opened {
	/// The window itself.
	pub window:    WindowHandle<ShellView>,
	/// What the last window left behind, which the host is handed so its
	/// store starts from it.
	pub persisted: PersistedState,
	/// The writer for this window's own record, absent when no state
	/// directory could be resolved.
	pub keeper:    Option<Keeper>,
}

/// What closing a window does to the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowExit {
	/// The window goes and the process stays up, because something can bring
	/// a window back.
	CloseWindow,
	/// The window goes and the process ends with it, because nothing can.
	CloseAndQuit,
}

/// Whether closing the last window leaves a process anything can reopen.
///
/// macOS keeps an application up with no window: the menu bar stays, the dock
/// icon stays, and a press on either asks for a window back. Everywhere else a
/// process with no window is a process with no way in, so it ends.
#[must_use]
pub const fn reopen_available() -> bool {
	cfg!(target_os = "macos")
}

/// What closing one window does, given how many are open and whether anything
/// can reopen.
///
/// Closing one of several windows never ends the process, whatever the
/// platform; closing the last one ends it unless a reopen can bring it back.
#[must_use]
pub const fn window_exit(windows_open: usize, reopen_available: bool) -> WindowExit {
	if windows_open > 1 || reopen_available {
		WindowExit::CloseWindow
	} else {
		WindowExit::CloseAndQuit
	}
}

/// Opens the shell window: the remembered placement, the remembered
/// appearance, and the queue shape the last window was left in.
///
/// The state directory is read here rather than once per process, so a window
/// a reopen brings back starts from what the closing window wrote rather than
/// from what the process read at launch.
pub fn open_shell_window(bundle: &StartupBundle, cx: &mut App) -> Option<Opened> {
	let state_dir = StateDir::discover();
	let (persisted, rejections) = state_dir
		.as_ref()
		.map_or_else(|| (PersistedState::new(), Vec::new()), StateDir::load);
	report_rejections(&rejections);
	let keeper = state_dir.map(|dir| Keeper::new(dir, persisted.clone()));
	let appearance = chosen_appearance(&persisted).to_string();

	let min_width = bundle.tokens.surface.shell.window_min_width_px;
	let min_height = bundle.tokens.surface.shell.window_min_height_px;
	let displays: Vec<Bounds<Pixels>> = cx
		.displays()
		.into_iter()
		.map(|display| display.bounds())
		.collect();
	let (bounds, maximized) = placement(&persisted, &displays, min_width, min_height);
	let window_bounds = if maximized {
		WindowBounds::Maximized(bounds)
	} else {
		WindowBounds::Windowed(bounds)
	};

	// On macOS the window draws the titlebar itself and the traffic lights
	// land in the inset the shell's bar leaves for them (§4.1). Elsewhere the
	// window manager's decorations sit above the bar.
	let titlebar = cfg!(target_os = "macos").then(|| TitlebarOptions {
		title:                  None,
		appears_transparent:    true,
		traffic_light_position: Some(point(px(12.0), px(20.0))),
	});
	let window_options = WindowOptions {
		window_bounds: Some(window_bounds),
		titlebar,
		window_min_size: Some(Size { width: px(min_width), height: px(min_height) }),
		..Default::default()
	};

	let tokens = bundle.tokens.clone();
	let themes = bundle.themes.clone();
	let surface_path = bundle.surface_path.clone();
	let window = match cx.open_window(window_options, |_, cx| {
		let library = ThemeLibrary::new(&tokens, themes.clone(), &surface_path);
		let installed = match install_appearances(cx, library, &appearance) {
			Ok(installed) => installed,
			Err(error) => {
				eprintln!("Fatal: failed to install tokens: {error}");
				process::exit(1);
			},
		};
		let state = ShellState {
			appearance: AppearanceChoice::new(appearance.as_str()),
			..ShellState::default()
		};
		cx.new(|_| ShellView::new(installed, state))
	}) {
		Ok(handle) => handle,
		Err(error) => {
			eprintln!("Fatal: failed to open window: {error:?}");
			return None;
		},
	};

	// The queue's collapse is the window's, not a session's, so it is put back
	// before the first frame rather than when a session opens.
	if let Some(keeper) = keeper.as_ref() {
		let _ = window.update(cx, |view, _window, cx| {
			keeper.restore_host(view);
			cx.notify();
		});
	}

	Some(Opened { window, persisted, keeper })
}
