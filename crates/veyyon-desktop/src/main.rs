//! Veyyon desktop front end entry point.
//!
//! Section 4.1, 8.1, and 8.4:
//! Loads tokens and bundled dark theme, validates at startup, opens the main
//! window with the minimum dimensions from `ShellSurfaceTokens`, starts
//! `TokenWatcher` for background hot reload, and runs the GPUI event loop.

use std::process;

use veyyon_desktop::{discover_asset_paths, load_startup_bundle, start_token_supervision};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_desktop_tokens::TokenReloadMessage;
use veyyon_gpui::{
	App, AppContext, Application, AsyncApp, Bounds, Point, Size, WindowBounds, WindowOptions, px,
};

fn main() {
	let paths = discover_asset_paths();
	let bundle = match load_startup_bundle(paths) {
		Ok(bundle) => bundle,
		Err(error) => {
			eprintln!("Fatal: failed to load design tokens or bundled theme: {error}");
			process::exit(1);
		},
	};

	let min_width = bundle.tokens.surface.shell.window_min_width_px;
	let min_height = bundle.tokens.surface.shell.window_min_height_px;

	let tokens = bundle.tokens.clone();
	let theme = bundle.theme.clone();
	let surface_path = bundle.surface_path.clone();
	let tokens_dir = bundle.paths.tokens_dir;

	let platform = gpui_platform::current_platform(false);
	let app = Application::with_platform(platform);
	app.run(move |cx: &mut App| {
		let window_bounds = WindowBounds::Windowed(Bounds {
			origin: Point { x: px(0.0), y: px(0.0) },
			size:   Size { width: px(min_width), height: px(min_height) },
		});

		let window_options = WindowOptions {
			window_bounds: Some(window_bounds),
			titlebar: None,
			window_min_size: Some(Size { width: px(min_width), height: px(min_height) }),
			..Default::default()
		};

		let window_handle = match cx.open_window(window_options, |_, cx| {
			let installed = match install_tokens(cx, &tokens, &theme, &surface_path) {
				Ok(installed) => installed,
				Err(error) => {
					eprintln!("Fatal: failed to install tokens: {error}");
					process::exit(1);
				},
			};
			cx.new(|_| ShellView::new(installed, fixture::populated()))
		}) {
			Ok(handle) => handle,
			Err(error) => {
				eprintln!("Fatal: failed to open window: {error:?}");
				process::exit(1);
			},
		};

		// Background token watcher for hot reload (§8.4).
		let (watcher, rx) = match start_token_supervision(&tokens_dir) {
			Ok(supervision) => supervision,
			Err(error) => {
				// A window whose watcher never started is indistinguishable
				// from one whose watcher works, until an edit fails to arrive.
				// It goes on the surface the operator is looking at.
				let _ = window_handle.update(cx, |view, _window, cx| {
					view.set_notice(Some(format!(
						"token hot reload is off: {error}; restart to pick up token edits"
					)));
					cx.notify();
				});
				return;
			},
		};

		let window = window_handle;
		cx.spawn(move |cx: &mut AsyncApp| {
			let mut async_cx = cx.clone();
			async move {
				let _keep_watcher = watcher;
				while let Ok(msg) = rx.recv_async().await {
					match msg {
						TokenReloadMessage::Applied(new_tokens) => {
							let reload_theme = theme.clone();
							let reload_surface = surface_path.clone();
							let _ = window.update(&mut async_cx, move |view, _window, cx| {
								match install_tokens(cx, &new_tokens, &reload_theme, &reload_surface) {
									Ok(installed) => {
										view.set_tokens(installed);
										view.set_notice(None);
									},
									Err(err) => view.set_notice(Some(err.to_string())),
								}
								cx.notify();
							});
						},
						TokenReloadMessage::Failed(err) => {
							let _ = window.update(&mut async_cx, move |view, _window, cx| {
								view.set_notice(Some(err.to_string()));
								cx.notify();
							});
						},
					}
				}
			}
		})
		.detach();
	});
}
