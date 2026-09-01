//! Veyyon desktop front end entry point.
//!
//! Section 4.1, 8.1, 8.4 and 8.11: loads tokens and the bundled dark theme,
//! validates them at startup, opens the main window at the minimum
//! dimensions from `ShellSurfaceTokens`, starts `TokenWatcher` for hot
//! reload, attaches to a GUI host — starting one when nothing listens — and
//! runs the GPUI event loop with the host's events projected onto the shell.

use std::{cell::RefCell, env, process, rc::Rc};

use veyyon_desktop::{
	HostLink, SessionIndex, actions_for, connect_or_spawn, current_timestamp_ms,
	discover_asset_paths, load_startup_bundle, project, start_token_supervision,
};
use veyyon_desktop_model::{ConnectionState, HostEvent, Store, reduce};
use veyyon_desktop_surface::{ShellState, ShellView, install_tokens};
use veyyon_desktop_tokens::TokenReloadMessage;
use veyyon_gpui::{
	App, AppContext, Application, AsyncApp, Bounds, Point, Size, WindowBounds, WindowOptions, px,
};

/// The window's side of the host: the protocol model, the row identities, and
/// the link requests go out on. One owner, on the UI thread.
struct Host {
	store: Store,
	index: SessionIndex,
	link:  HostLink,
}

/// The `--endpoint <addr>` or `--endpoint=<addr>` argument, if given.
fn endpoint_argument() -> Option<String> {
	let mut args = env::args().skip(1);
	while let Some(arg) = args.next() {
		if arg == "--endpoint" {
			return args.next();
		}
		if let Some(value) = arg.strip_prefix("--endpoint=") {
			return Some(value.to_string());
		}
	}
	None
}

/// What the attention strip says about a connection state, or `None` when
/// the connection needs no attention.
fn connection_notice(state: &ConnectionState) -> Option<String> {
	match state {
		ConnectionState::Connected { .. } => None,
		ConnectionState::Detached => Some("not attached to a host".to_string()),
		ConnectionState::Connecting { attempt } => Some(format!("connecting (attempt {attempt})")),
		ConnectionState::Syncing { received, expected } => Some(match expected {
			Some(expected) => format!("syncing {received}/{expected}"),
			None => format!("syncing ({received} received)"),
		}),
		ConnectionState::Reconnecting { attempt, message, .. } => {
			Some(format!("reconnecting (attempt {attempt}): {message}"))
		},
		ConnectionState::Fatal { message } => Some(format!("host unreachable: {message}")),
	}
}

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
	let endpoint_argument = endpoint_argument();

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
												view.set_notice(None);
											},
											Err(err) => view.set_notice(Some(err.to_string())),
										}
									},
									None => view.set_notice(notice),
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
					view.set_notice(Some(format!(
						"token hot reload is off: {error}; restart to pick up token edits"
					)));
					cx.notify();
				});
			},
		}

		// Attach to a host, or start one (§8.11).
		let cwd = env::current_dir().unwrap_or_else(|_| ".".into());
		let attachment = match connect_or_spawn(endpoint_argument.as_deref(), &cwd) {
			Ok(attachment) => attachment,
			Err(error) => {
				let _ = window.update(cx, |view, _window, cx| {
					view.set_notice(Some(format!("no host: {error}")));
					cx.notify();
				});
				return;
			},
		};
		let (link, mut events) = match HostLink::start(attachment.endpoint.clone()) {
			Ok(started) => started,
			Err(error) => {
				let _ = window.update(cx, |view, _window, cx| {
					view.set_notice(Some(format!("transport failed to start: {error}")));
					cx.notify();
				});
				return;
			},
		};
		let _ = window.update(cx, |view, _window, cx| {
			view.set_notice(Some(match &attachment.spawned {
				Some(child) => {
					format!("started veyyon gui (pid {}) at {}", child.pid, attachment.endpoint)
				},
				None => format!("attaching to {}", attachment.endpoint),
			}));
			cx.notify();
		});

		let host =
			Rc::new(RefCell::new(Host { store: Store::new(), index: SessionIndex::new(), link }));

		// Intents the operator raised go to the host as actions. Every
		// dispatch notifies the view, so observing it drains them at once.
		if let Ok(view) = window.entity(cx) {
			let host = Rc::clone(&host);
			cx.observe(&view, move |view, cx| {
				let intents = view.update(cx, |view, _| view.drain_intents());
				if intents.is_empty() {
					return;
				}
				let mut host = host.borrow_mut();
				let host = &mut *host;
				for intent in &intents {
					for action in actions_for(intent, &host.index, &mut host.store) {
						host.link.send(action);
					}
				}
			})
			.detach();
		}

		// Events from the host reduce into the store and project onto the
		// shell. Everything already queued is drained before one projection,
		// so a burst of streaming deltas costs one projection, not one each.
		cx.spawn(move |cx: &mut AsyncApp| {
			let mut async_cx = cx.clone();
			async move {
				while let Some(first) = events.recv().await {
					let mut batch = vec![first];
					while let Ok(event) = events.try_recv() {
						batch.push(event);
					}
					let host = Rc::clone(&host);
					let _ = window.update(&mut async_cx, move |view, _window, cx| {
						let mut host = host.borrow_mut();
						let host = &mut *host;
						let mut notice: Option<Option<String>> = None;
						for event in batch {
							match &event {
								HostEvent::ConnectionChanged(state) => {
									notice = Some(connection_notice(state));
								},
								HostEvent::RequestFailed { error, .. } => {
									notice = Some(Some(error.message.clone()));
								},
								HostEvent::FatalProtocolError { message } => {
									notice = Some(Some(format!("protocol error: {message}")));
								},
								_ => {},
							}
							let _damage = reduce(&mut host.store, event);
						}
						project(&host.store, &mut host.index, current_timestamp_ms(), view.state_mut());
						if let Some(notice) = notice {
							view.set_notice(notice);
						}
						cx.notify();
					});
				}
			}
		})
		.detach();
	});
}
