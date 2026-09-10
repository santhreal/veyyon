//! Veyyon desktop front end entry point.
//!
//! Section 4.1, 8.1, 8.4 and 8.11: loads tokens and the bundled dark theme,
//! validates them at startup, opens the main window at the minimum
//! dimensions from `ShellSurfaceTokens`, starts `TokenWatcher` for hot
//! reload, attaches to a GUI host — starting one when nothing listens — and
//! runs the GPUI event loop with the host's events projected onto the shell.

mod host_view;

use std::{env, process};

use clap::Parser as _;
use veyyon_desktop::{
	cli::{Cli, Command},
	connect_or_spawn, discover_asset_paths, load_startup_bundle, scene, start_token_supervision,
	state::{Keeper, StateDir, placement, report_rejections},
};
use veyyon_desktop_model::PersistedState;
use veyyon_desktop_surface::{Keymap, ShellState, ShellView, install_tokens};
use veyyon_desktop_tokens::TokenReloadMessage;
use veyyon_gpui::{
	App, AppContext, Application, AsyncApp, Bounds, Pixels, Size, TitlebarOptions, WindowBounds,
	WindowOptions, point, px,
};

fn main() {
	let cli = Cli::parse();
	let paths = discover_asset_paths();
	let bundle = match load_startup_bundle(paths) {
		Ok(bundle) => bundle,
		Err(error) => {
			eprintln!("Fatal: failed to load design tokens or bundled theme: {error}");
			process::exit(1);
		},
	};

	let endpoint_argument = match cli.command {
		Some(Command::Scene(command)) => process::exit(scene::run_scene(&bundle, command)),
		Some(Command::Sweep(command)) => process::exit(scene::run_sweep(&bundle, command)),
		Some(Command::Tokens(command)) => process::exit(scene::run_tokens(&bundle, command)),
		None => cli.endpoint,
	};

	let min_width = bundle.tokens.surface.shell.window_min_width_px;
	let min_height = bundle.tokens.surface.shell.window_min_height_px;

	// What the last window left behind, read once before anything is drawn
	// (§8.10). A store this binary does not recognise states itself on stderr
	// and leaves its default, so the window comes up rather than refusing to.
	let state_dir = StateDir::discover();
	let (persisted, rejections) = state_dir
		.as_ref()
		.map_or_else(|| (PersistedState::new(), Vec::new()), StateDir::load);
	report_rejections(&rejections);
	let keeper = state_dir.map(|dir| Keeper::new(dir, persisted.clone()));

	let tokens = bundle.tokens.clone();
	let theme = bundle.theme.clone();
	let surface_path = bundle.surface_path.clone();
	let tokens_dir = bundle.paths.tokens_dir;

	let platform = gpui_platform::current_platform(false);
	let app = Application::with_platform(platform);
	app.run(move |cx: &mut App| {
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

		// On macOS the window draws the titlebar itself and the traffic
		// lights land in the inset the shell's bar leaves for them (§4.1).
		// Elsewhere the window manager's decorations sit above the bar.
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

		let window = match cx.open_window(window_options, |_, cx| {
			let installed = match install_tokens(cx, &tokens, &theme, &surface_path) {
				Ok(installed) => installed,
				Err(error) => {
					eprintln!("Fatal: failed to install tokens: {error}");
					process::exit(1);
				},
			};
			cx.new(|_| ShellView::new(installed, ShellState::default()))
		}) {
			Ok(handle) => handle,
			Err(error) => {
				eprintln!("Fatal: failed to open window: {error:?}");
				process::exit(1);
			},
		};
		cx.bind_keys(Keymap::default().bindings());

		// The queue's collapse is the window's, not a session's, so it is put
		// back before the first frame rather than when a session opens.
		let mut keeper = keeper;
		if let Some(keeper) = keeper.as_ref() {
			let _ = window.update(cx, |view, _window, cx| {
				keeper.restore_host(view);
				cx.notify();
			});
		}

		// Background token watcher for hot reload (§8.4).
		match start_token_supervision(&tokens_dir) {
			Ok((watcher, rx)) => {
				let theme = theme.clone();
				let surface_path = surface_path.clone();
				cx.spawn(move |cx: &mut AsyncApp| {
					let mut async_cx = cx.clone();
					async move {
						let _keep_watcher = watcher;
						while let Ok(msg) = rx.recv_async().await {
							let (installed, notice) = match msg {
								TokenReloadMessage::Applied(new_tokens) => (Some(new_tokens), None),
								TokenReloadMessage::Failed(err) => (None, Some(err.to_string())),
							};
							let theme = theme.clone();
							let surface_path = surface_path.clone();
							let _ = window.update(&mut async_cx, move |view, _window, cx| {
								match installed {
									Some(new_tokens) => {
										match install_tokens(cx, &new_tokens, &theme, &surface_path) {
											Ok(installed) => {
												view.set_tokens(installed);
												view.set_notice(None, cx);
											},
											Err(err) => view.set_notice(Some(err.to_string()), cx),
										}
									},
									None => view.set_notice(notice, cx),
								}
								cx.notify();
							});
						}
					}
				})
				.detach();
			},
			Err(error) => {
				// A window whose watcher never started is indistinguishable
				// from one whose watcher works, until an edit fails to arrive.
				// It goes on the surface the operator is looking at.
				let _ = window.update(cx, |view, _window, cx| {
					view.set_notice(
						Some(format!("token hot reload is off: {error}; restart to pick up token edits")),
						cx,
					);
					cx.notify();
				});
			},
		}

		// Host startup can block on a cold CLI import graph. Keep the window
		// responsive and retain the transport after a startup timeout.
		let _ = window.update(cx, |view, _window, cx| {
			view.state_mut().connection =
				veyyon_desktop_surface::attach::ConnectionPhase::Connecting { attempt: 1 };
			view.set_notice(Some("Starting GUI host".to_string()), cx);
			cx.notify();
		});
		let startup = cx.background_executor().spawn(async move {
			let cwd = env::current_dir().unwrap_or_else(|_| ".".into());
			connect_or_spawn(endpoint_argument.as_deref(), &cwd)
		});
		cx.spawn(move |cx: &mut AsyncApp| {
			let async_cx = cx.clone();
			async move {
				let attachment = startup.await;
				async_cx.update(|cx| {
					let attachment = match attachment {
						Ok(attachment) => attachment,
						Err(error) => {
							let _ = window.update(cx, |view, _window, cx| {
								view.set_notice(Some(format!("no host: {error}")), cx);
								view.state_mut().connection =
									veyyon_desktop_surface::attach::ConnectionPhase::Fatal {
										message: error.to_string(),
									};
								cx.notify();
							});
							return;
						},
					};
					host_view::attach(attachment, persisted, keeper.take(), window, cx);
				});
			}
		})
		.detach();
	});
}
