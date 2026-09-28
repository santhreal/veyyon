//! Veyyon desktop front end entry point.
//!
//! Opens the workspace window over one `AppState` and attaches it to a GUI
//! host, starting one when nothing listens (§8.1, §8.11). With
//! `VEYYON_DESKTOP_DRIVER` set, the driver socket (§7) opens before the
//! window does.

mod window;

use std::{env, path::Path, process, rc::Rc};

use clap::Parser as _;
use veyyon_desktop::{
	cli::Cli,
	launch::{WindowExit, reopen_available, window_exit},
};
use veyyon_desktop_app::{driver, keymap};
use veyyon_desktop_ui::{fonts, icons::Assets};
use veyyon_gpui::{App, Application};

fn main() {
	let endpoint = Cli::parse().endpoint;

	let slot = window::Slot::default();
	let app = Application::with_platform(gpui_platform::current_platform(false)).with_assets(Assets);

	// A dock press on a process with no window asks for one back, and what it
	// gets is a launch: the same placement, the same appearance and the
	// session the closing window wrote (§8.10). Nothing fires this where no
	// window can be reopened, and a process that still has its window
	// ignores it.
	{
		let slot = Rc::clone(&slot);
		let endpoint = endpoint.clone();
		app.on_reopen(move |cx: &mut App| {
			if slot.borrow().is_none() {
				window::open(endpoint.clone(), &slot, cx);
			}
		});
	}

	app.run(move |cx: &mut App| {
		if let Err(error) = prepare(cx) {
			eprintln!("Fatal: {error}");
			process::exit(1);
		}

		// A closed window is no longer the one this process draws: its slot
		// empties, which releases its link and writes what it remembers, and
		// the process ends unless something can bring a window back.
		{
			let slot = Rc::clone(&slot);
			cx.on_window_closed(move |cx, closed| {
				let ours = slot
					.borrow()
					.as_ref()
					.is_some_and(|opened| opened.window.window_id() == closed);
				if !ours {
					return;
				}
				let released = slot.borrow_mut().take();
				drop(released);
				if window_exit(cx.windows().len() + 1, reopen_available()) == WindowExit::CloseAndQuit {
					cx.quit();
				}
			})
			.detach();
		}

		window::open(endpoint, &slot, cx);
	});
}

/// Registers what every window needs before the first one opens: the
/// embedded faces, the regions' globals and listeners, the default key
/// bindings, and the driver socket when one is named.
fn prepare(cx: &mut App) -> Result<(), String> {
	fonts::register(cx).map_err(|error| format!("the embedded fonts did not load: {error:#}"))?;
	veyyon_desktop_app::init(cx);
	keymap::install(cx).map_err(|error| error.to_string())?;
	if let Some(path) = env::var_os(driver::SOCKET_VAR).filter(|path| !path.is_empty()) {
		let path = Path::new(&path);
		driver::start(path, cx)
			.map_err(|error| format!("the driver socket {} did not open: {error}", path.display()))?;
	}
	Ok(())
}
