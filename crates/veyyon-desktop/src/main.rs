//! Veyyon desktop front end entry point.
//!
//! Section 4.1, 8.1, 8.4 and 8.11: loads tokens and the bundled dark theme,
//! validates them at startup, opens the main window at the minimum
//! dimensions from `ShellSurfaceTokens`, starts `TokenWatcher` for hot
//! reload, attaches to a GUI host — starting one when nothing listens — and
//! runs the GPUI event loop with the host's events projected onto the shell.

use std::{cell::RefCell, collections::HashMap, env, process, rc::Rc};

use clap::Parser as _;
use veyyon_desktop::{
	HostLink, SessionIndex, actions_for,
	cli::{Cli, Command},
	connect_or_spawn, current_timestamp_ms, discover_asset_paths, land_failure, load_startup_bundle,
	project,
	project::connection_notice,
	project_controls, request_frame, scene, start_token_supervision,
};
use veyyon_desktop_model::{HostEvent, RequestRegistry, SessionId, Store, SurfaceId, reduce};
use veyyon_desktop_surface::{
	Intent, Keymap, ShellState, ShellView, damage::regions_changed, install_tokens,
	terminal::TerminalEmulator,
};
use veyyon_desktop_tokens::TokenReloadMessage;
use veyyon_gpui::{
	App, AppContext, Application, AsyncApp, Bounds, Point, Size, TitlebarOptions, WindowBounds,
	WindowOptions, point, px,
};

/// The window's side of the host: the protocol model, the row identities, and
/// the link requests go out on. One owner, on the UI thread.
struct Host {
	store:     Store,
	index:     SessionIndex,
	link:      HostLink,
	registry:  RequestRegistry,
	terminals: HashMap<String, TerminalEmulator>,
	/// The state the window drew last, so a batch's projection can be
	/// diffed region by region and repainted inside what changed (P5).
	drawn:     ShellState,
}

/// Resolves the initiating surface for an operator intent.
fn surface_for_intent(intent: &Intent, active_session: Option<&SessionId>) -> SurfaceId {
	if let Some(surface) = active_session.and_then(|session| {
		veyyon_desktop_surface::composer::actions::request_surface(intent, session)
	}) {
		return surface;
	}
	match intent {
		Intent::RetryConnection => SurfaceId::ConnectionRetryButton,
		Intent::StartProviderAuth(p) => SurfaceId::ProviderAuthStartButton(p.clone()),
		Intent::SubmitAuthSecret { provider, .. } => {
			SurfaceId::ProviderAuthSecretSubmit(provider.clone())
		},
		Intent::OpenAuthUrl(url) => SurfaceId::ProviderAuthUrlOpen(url.clone()),
		Intent::CancelAuthFlow => SurfaceId::ProviderAuthCancelButton(String::new()),
		Intent::RetryAuthFlow => SurfaceId::ProviderAuthRetryButton(String::new()),
		Intent::RetryControl(id) => id.clone(),
		Intent::SelectSession(id) => SurfaceId::QueueSessionRow(SessionId(id.to_string())),
		Intent::SetDrawer { .. } => SurfaceId::TerminalCreateButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("active".into())),
		),
		Intent::SelectTab(_) => SurfaceId::RightPanelDiffTab(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("active".into())),
		),
		_ => SurfaceId::GlobalTitlebarLine,
	}
}
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

		let host = Rc::new(RefCell::new(Host {
			store: Store::new(),
			index: SessionIndex::new(),
			link,
			registry: RequestRegistry::new(),
			terminals: HashMap::new(),
			drawn: ShellState::default(),
		}));

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
				let active_session =
					Some(SessionId::from(view.read(cx).state().current_id.to_string()));
				let now_ms = current_timestamp_ms();
				for intent in &intents {
					let surface = surface_for_intent(intent, active_session.as_ref());
					for action in actions_for(intent, &host.index, &mut host.store) {
						let kind = action.kind();
						let req_id = host.link.send(action);
						host
							.registry
							.register(req_id, kind, surface.clone(), now_ms, 30_000);
						view.update(cx, |view, _cx| view.track_submission(req_id, intent));
					}
				}
				view.update(cx, |view, cx| {
					project_controls(&host.store, &host.registry, &host.index, view.state_mut());
					cx.notify();
				});
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
								HostEvent::RequestFailed { request, error } => {
									let active = host.store.persisted.shell.active_session.as_ref();
									if let Some(line) =
										land_failure(error, &host.registry, active, view.state_mut())
									{
										notice = Some(Some(line));
									}
									host.registry.complete(request);
									view.finish_submission(*request, false, cx);
								},
								HostEvent::RequestSucceeded { request } => {
									view.finish_submission(*request, true, cx);
									if let Some(in_flight) = host.registry.complete(request) {
										view.state_mut().controls.clear_error(&in_flight.surface);
									}
								},
								HostEvent::FatalProtocolError { message } => {
									notice = Some(Some(format!("protocol error: {message}")));
								},
								HostEvent::Snapshot(
									veyyon_desktop_model::SnapshotSection::Keybindings(views),
								) => {
									view.keymap_mut().apply_overrides(views);
									cx.bind_keys(view.keymap().bindings());
								},
								HostEvent::Snapshot(
									veyyon_desktop_model::SnapshotSection::TerminalOutput(chunk),
								) => {
									let emu = host
										.terminals
										.entry(chunk.terminal.clone())
										.or_insert_with(|| TerminalEmulator::new(80, 24));
									if chunk.reset {
										emu.reset();
									}
									emu.feed(&chunk.data);
								},
								_ => {},
							}
							let _damage = reduce(&mut host.store, event);
						}
						let now_ms = current_timestamp_ms();
						project(&host.store, &mut host.index, &host.terminals, now_ms, view.state_mut());
						project_controls(&host.store, &host.registry, &host.index, view.state_mut());
						// The clock the queue's elapsed labels and the connection
						// banner are measured against is the batch's, not the last
						// frame's.
						view.set_clock_ms(now_ms);
						// The attention strip is a view field, not state, and
						// it moves the columns when it appears, so a change to
						// it repaints the window regardless of the diff.
						let invalidation = regions_changed(&host.drawn, view.state());
						host.drawn.clone_from(view.state());
						match notice {
							Some(notice) => {
								view.set_notice(notice);
								cx.notify();
							},
							None => {
								request_frame(view, &invalidation, cx);
							},
						}
					});
				}
			}
		})
		.detach();
	});
}
