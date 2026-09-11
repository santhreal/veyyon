//! Veyyon desktop front end entry point.
//!
//! Section 4.1, 8.1, 8.4 and 8.11: loads tokens and the bundled dark theme,
//! validates them at startup, opens the main window at the minimum
//! dimensions from `ShellSurfaceTokens`, starts `TokenWatcher` for hot
//! reload, attaches to a GUI host — starting one when nothing listens — and
//! runs the GPUI event loop with the host's events projected onto the shell.

mod host_view;

use std::{env, process, rc::Rc};

use clap::Parser as _;
use veyyon_desktop::{
	StartupBundle,
	cli::{Cli, Command},
	connect_or_spawn, discover_asset_paths,
	launch::{WindowSlot, open_shell_window},
	load_startup_bundle, scene, start_token_supervision,
};
use veyyon_desktop_surface::{Keymap, reload_tokens};
use veyyon_desktop_tokens::TokenReloadMessage;
use veyyon_gpui::{App, Application, AsyncApp};

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

	let bundle = Rc::new(bundle);
	let slot = WindowSlot::default();
	let tokens_dir = bundle.paths.tokens_dir.clone();

	let platform = gpui_platform::current_platform(false);
	let app = Application::with_platform(platform);

	// A dock press on a process with no window asks for one back, and what it
	// gets is a launch: the same placement, the same appearance and the
	// session the closing window wrote (§8.10). Nothing fires this where no
	// window can be reopened, and a process that still has its window
	// ignores it.
	{
		let bundle = Rc::clone(&bundle);
		let slot = Rc::clone(&slot);
		let endpoint = endpoint_argument.clone();
		app.on_reopen(move |cx: &mut App| {
			if slot.borrow().is_some() {
				return;
			}
			start(&bundle, &slot, endpoint.clone(), cx);
		});
	}

	app.run(move |cx: &mut App| {
		cx.bind_keys(Keymap::default().bindings());

		// A closed window is no longer the window this process draws, so the
		// slot it was recorded in is emptied: a reopen opens a new one rather
		// than updating a handle to a window that is gone.
		{
			let slot = Rc::clone(&slot);
			cx.on_window_closed(move |_cx, closed| {
				let is_closed = slot
					.borrow()
					.as_ref()
					.is_some_and(|window| window.window_id() == closed);
				if is_closed {
					*slot.borrow_mut() = None;
				}
			})
			.detach();
		}

		start(&bundle, &slot, endpoint_argument, cx);

		// Background token watcher for hot reload (§8.4). It follows the slot
		// rather than one window, so an edit reaches the window that is up.
		match start_token_supervision(&tokens_dir) {
			Ok((watcher, rx)) => {
				let slot = Rc::clone(&slot);
				cx.spawn(move |cx: &mut AsyncApp| {
					let mut async_cx = cx.clone();
					async move {
						let _keep_watcher = watcher;
						while let Ok(msg) = rx.recv_async().await {
							let (installed, notice) = match msg {
								TokenReloadMessage::Applied(new_tokens) => (Some(new_tokens), None),
								TokenReloadMessage::Failed(err) => (None, Some(err.to_string())),
							};
							let Some(window) = *slot.borrow() else {
								continue;
							};
							let _ = window.update(&mut async_cx, move |view, _window, cx| {
								match installed {
									Some(new_tokens) => {
										// The reload is resolved against the appearance now
										// drawn, so an edit to a token file does not drop the
										// window out of the theme the operator chose.
										let appearance = view.state().appearance.drawn().to_string();
										match reload_tokens(cx, &new_tokens, &appearance) {
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
				let window = *slot.borrow();
				if let Some(window) = window {
					let _ = window.update(cx, |view, _window, cx| {
						view.set_notice(
							Some(format!(
								"token hot reload is off: {error}; restart to pick up token edits"
							)),
							cx,
						);
						cx.notify();
					});
				}
			},
		}
	});
}

/// Opens the window and attaches it to a host.
///
/// The launch path and the reopen path are one function, so a window brought
/// back from the dock comes up in the same placement, the same appearance and
/// on the same session as one the operator launched.
fn start(bundle: &StartupBundle, slot: &WindowSlot, endpoint: Option<String>, cx: &mut App) {
	let Some(opened) = open_shell_window(bundle, cx) else {
		return;
	};
	let window = opened.window;
	*slot.borrow_mut() = Some(window);

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
		connect_or_spawn(endpoint.as_deref(), &cwd)
	});
	let persisted = opened.persisted;
	let keeper = opened.keeper;
	let slot = Rc::clone(slot);
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
				host_view::attach(attachment, persisted, keeper, window, slot, cx);
			});
		}
	})
	.detach();
}
