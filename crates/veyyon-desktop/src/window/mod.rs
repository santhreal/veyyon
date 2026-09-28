//! The window this process opens: the workspace and its six regions over one
//! [`AppState`], attached to a host.
//!
//! The state directory is read on every open rather than once per process, so
//! a window a reopen brings back starts from what the closing window wrote.

mod host;
mod keep;
#[cfg(test)]
mod tests;

use std::{cell::RefCell, env, rc::Rc};

use veyyon_desktop::{
	connect_or_spawn,
	state::{StateDir, placement, report_rejections},
};
use veyyon_desktop_app::{AppState, composer, regions, workspace::Workspace};
use veyyon_desktop_model::{ConnectionState, PersistedState, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme};
use veyyon_gpui::{
	App, AppContext as _, Bounds, Entity, Pixels, TitlebarOptions, WindowBounds, WindowDecorations,
	WindowHandle, WindowOptions, px, size,
};

use self::{host::Host, keep::Keep};

/// The narrowest window the transcript column and its gutters fit in.
const MIN_WIDTH: f32 = 800.0;
/// The shortest window the header, a transcript line and the composer fit in.
const MIN_HEIGHT: f32 = 560.0;
/// The application id desktop environments group the window under.
const APP_ID: &str = "dev.veyyon.desktop";

/// The window this process draws and the entity linking it to a host.
pub struct Opened {
	/// The window.
	pub window: WindowHandle<Workspace>,
	_host:      Entity<Host>,
}

/// The open window, empty while none is open.
pub type Slot = Rc<RefCell<Option<Opened>>>;

/// Opens the window where the last one was left, in the appearance it was
/// left in, records it in `slot`, and attaches it to the host at `endpoint`,
/// starting one when nothing listens there.
///
/// Resolving the host can block on a cold start, so it runs off the UI
/// thread; the window draws `Connecting` meanwhile, and intents raised in
/// that time are sent once the transport is up.
pub fn open(endpoint: Option<String>, slot: &Slot, cx: &mut App) {
	let dir = StateDir::discover();
	let (persisted, rejections) = dir
		.as_ref()
		.map_or_else(|| (PersistedState::new(), Vec::new()), StateDir::load);
	report_rejections(&rejections);
	if let Err(error) = Theme::install(appearance(&persisted, cx), cx) {
		eprintln!("Fatal: {error}");
		cx.quit();
		return;
	}
	let panels = persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|session| persisted.panels.get(session))
		.cloned()
		.unwrap_or_default();
	if let Some(dir) = &dir {
		composer::stash::install(dir.root(), cx);
	}
	let keep = Keep::new(dir, &persisted);
	let options = options(&persisted, cx);
	let app = cx.new(|_| AppState::new(Store::with_persisted(persisted)));
	let opened = cx.open_window(options, |window, cx| {
		let regions = regions::build(&app, window, cx);
		cx.new(|cx| Workspace::new(app.clone(), regions, panels, window, cx))
	});
	let window = match opened {
		Ok(window) => window,
		Err(error) => {
			eprintln!("Fatal: the window did not open: {error:#}");
			cx.quit();
			return;
		},
	};
	let host = window.update(cx, |_, window, cx| {
		let workspace = cx.entity();
		cx.new(|cx| Host::new(app, &workspace, keep, window, cx))
	});
	let host = match host {
		Ok(host) => host,
		Err(error) => {
			eprintln!("Fatal: the window closed while it opened: {error:#}");
			cx.quit();
			return;
		},
	};
	*slot.borrow_mut() = Some(Opened { window, _host: host.clone() });
	host.update(cx, |host, cx| host.connection(ConnectionState::Connecting { attempt: 1 }, cx));

	let startup = cx.background_executor().spawn(async move {
		let cwd = env::current_dir().unwrap_or_else(|_| ".".into());
		connect_or_spawn(endpoint.as_deref(), &cwd)
	});
	let host = host.downgrade();
	cx.spawn(async move |cx| {
		let attachment = startup.await;
		let _ = host.update(cx, |host, cx| match attachment {
			Ok(attachment) => host.attach(&attachment, cx),
			Err(error) => {
				let message = format!("no host: {error}");
				host.connection(ConnectionState::Fatal { message }, cx);
			},
		});
	})
	.detach();
}

/// The appearance the window was left in, or the system's when none was
/// chosen.
fn appearance(state: &PersistedState, cx: &App) -> Appearance {
	match state.shell.appearance.as_deref() {
		Some("light") => Appearance::Light,
		Some(_) => Appearance::Dark,
		None => Appearance::from_system(cx.window_appearance()),
	}
}

/// The remembered placement, clamped to a display this machine has, with a
/// client-drawn titlebar: the thread header and the sidebar's top row move
/// the window and the header draws its controls.
fn options(state: &PersistedState, cx: &App) -> WindowOptions {
	let displays: Vec<Bounds<Pixels>> = cx
		.displays()
		.into_iter()
		.map(|display| display.bounds())
		.collect();
	let (bounds, maximized) = placement(state, &displays, MIN_WIDTH, MIN_HEIGHT);
	WindowOptions {
		window_bounds: Some(if maximized {
			WindowBounds::Maximized(bounds)
		} else {
			WindowBounds::Windowed(bounds)
		}),
		titlebar: Some(TitlebarOptions {
			title:                  Some("Veyyon".into()),
			appears_transparent:    true,
			traffic_light_position: None,
		}),
		app_owns_titlebar_drag: true,
		window_decorations: Some(WindowDecorations::Client),
		window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
		app_id: Some(APP_ID.to_string()),
		..WindowOptions::default()
	}
}
