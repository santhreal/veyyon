//! Veyyon's GPU front end.
//!
//! Today it opens a window and draws the presentation contract's fixtures: the
//! thread list, a transcript, a composer, the bottom panel, a status bar, and
//! whichever routed screen was asked for. There is no session behind it and no
//! transport yet, which is deliberate — the shell is built against
//! [`veyyon_gui_contract::fixtures`] so every view-model variant is drawn
//! before a transport can hide one.
//!
//! ```text
//! veyyon-gui --theme dark-gruvbox --route pick
//! veyyon-gui --sidebar off --terminal on
//! veyyon-gui --list-routes
//! ```

mod args;

use gpui::{App, AppContext, Bounds, WindowBounds, WindowOptions, px, size};
use gpui_platform::application;
use veyyon_gui_contract::fixtures::Fixtures;
use veyyon_gui_kit::{Typography, theme::Theme};
use veyyon_gui_shell::{Chrome, Shell};

use crate::args::{Arguments, Outcome};

fn main() {
	let arguments = match Arguments::parse(std::env::args().skip(1)) {
		Ok(Outcome::Run(arguments)) => arguments,
		Ok(Outcome::Printed(text)) => {
			println!("{text}");
			return;
		},
		Err(message) => {
			eprintln!("veyyon-gui: {message}");
			eprintln!("{}", args::USAGE);
			std::process::exit(2);
		},
	};

	application().run(move |cx: &mut App| {
		install(&arguments, cx);

		let bounds = Bounds::centered(None, size(px(arguments.width), px(arguments.height)), cx);
		let window = cx.open_window(
			WindowOptions {
				window_bounds: Some(WindowBounds::Windowed(bounds)),
				titlebar: Some(gpui::TitlebarOptions {
					title: Some("veyyon".into()),
					..Default::default()
				}),
				..Default::default()
			},
			|_, cx| {
				let mut fixtures = Fixtures::at(arguments.route);
				if let Some(index) = arguments.dialog {
					fixtures = fixtures.dialog(index);
				}
				let chrome = Chrome { sidebar: arguments.sidebar, terminal: arguments.terminal };
				cx.new(|cx| Shell::new(Box::new(fixtures), cx).chrome(chrome))
			},
		);
		if let Err(error) = window {
			eprintln!("veyyon-gui: the window could not be opened: {error}");
			cx.quit();
			return;
		}
		cx.activate(true);

		if let Some(after) = arguments.exit_after_ms {
			// A capture run needs the process to end on its own: the recorder
			// grabs the display and then waits for the window to close. Spawning
			// on the foreground executor keeps the timer on the main thread,
			// which is where gpui requires the quit to happen.
			cx.spawn(async move |cx| {
				cx.background_executor()
					.timer(std::time::Duration::from_millis(after))
					.await;
				cx.update(|cx| cx.quit());
			})
			.detach();
		}
	});
}

/// Install the app-level globals the shell reads: the palette, and the resolved
/// font families.
fn install(arguments: &Arguments, cx: &mut App) {
	Typography::install(cx);

	let Some(name) = &arguments.theme else {
		Theme::set_default(cx);
		return;
	};
	match Theme::set_builtin(name, cx) {
		Ok(true) => {},
		Ok(false) => {
			eprintln!("veyyon-gui: no bundled theme named {name}; using the default");
			Theme::set_default(cx);
		},
		Err(error) => {
			eprintln!("veyyon-gui: the theme {name} does not resolve: {error}");
			Theme::set_default(cx);
		},
	}
}
