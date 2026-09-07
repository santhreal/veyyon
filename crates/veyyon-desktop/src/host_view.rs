//! Window-owned host transport, intent dispatch and event projection.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use veyyon_desktop::{
	Attachment, HostLink, SessionIndex, actions_for, current_timestamp_ms, land_failure, project,
	project::{connection_notice, restored_draft},
	project_clock, project_controls, request_frame,
	state::Keeper,
};
use veyyon_desktop_model::{
	HostAction, HostEvent, PersistedState, RequestRegistry, SessionId, Store, SurfaceId, reduce,
};
use veyyon_desktop_surface::{
	Intent, ShellState, ShellView, damage::regions_changed, terminal::TerminalEmulator,
};
use veyyon_gpui::{App, AsyncApp, Context, Window, WindowHandle};

use crate::request_surface;

struct Host {
	store:     Store,
	index:     SessionIndex,
	link:      HostLink,
	registry:  RequestRegistry,
	terminals: HashMap<String, TerminalEmulator>,
	drawn:     ShellState,
	/// What the window remembers, absent when there is no directory to keep it
	/// in (§8.10).
	keeper:    Option<Keeper>,
}

impl Host {
	/// Records the drawn window's shape and writes what is due, stating a
	/// store that could not be written on the surface the operator is looking
	/// at rather than only on stderr.
	fn keep(
		&mut self,
		view: &mut ShellView,
		window: &Window,
		now_ms: u64,
		cx: &mut Context<ShellView>,
	) {
		let Some(keeper) = self.keeper.as_mut() else {
			return;
		};
		let failures = keeper.sync(view, &mut self.store, window, now_ms, cx);
		if let Some(failure) = failures.first() {
			view.set_notice(Some(format!(
				"{store} was not saved: {reason}",
				store = failure.kind.file_name(),
				reason = failure.reason,
			)));
		}
	}
}

pub fn attach(
	attachment: Attachment,
	persisted: PersistedState,
	keeper: Option<Keeper>,
	window: WindowHandle<ShellView>,
	cx: &mut App,
) {
	if window.entity(cx).is_err() {
		return;
	}
	let (link, mut events) = match HostLink::start(attachment.endpoint.clone()) {
		Ok(started) => started,
		Err(error) => {
			let _ = window.update(cx, |view, _window, cx| {
				view.set_notice(Some(format!("transport failed to start: {error}")));
				view.state_mut().connection = veyyon_desktop_surface::attach::ConnectionPhase::Fatal {
					message: error.to_string(),
				};
				cx.notify();
			});
			return;
		},
	};
	let _ = window.update(cx, |view, _window, cx| {
		view.set_notice(Some(match &attachment.spawned {
			Ok(Some(child)) => {
				format!("started veyyon gui (pid {}) at {}", child.pid, attachment.endpoint)
			},
			Ok(None) => format!("attaching to {}", attachment.endpoint),
			Err(error) => format!("Host startup: {error}; connecting to {}", attachment.endpoint),
		}));
		cx.notify();
	});

	let host = Rc::new(RefCell::new(Host {
		store: Store::with_persisted(persisted),
		index: SessionIndex::new(),
		link,
		registry: RequestRegistry::new(),
		terminals: HashMap::new(),
		drawn: ShellState::default(),
		keeper,
	}));

	// A clean shutdown writes what the debounce is still holding, and the
	// shape the window took on since the last write (§8.10).
	{
		let host = Rc::clone(&host);
		cx.on_app_quit(move |cx: &mut App| {
			let host = Rc::clone(&host);
			let _ = window.update(cx, |view, window, cx| {
				let mut host = host.borrow_mut();
				let now_ms = current_timestamp_ms();
				host.keep(view, window, now_ms, cx);
				if let Some(keeper) = host.keeper.as_mut() {
					for failure in keeper.flush_all() {
						eprintln!(
							"warn: {store} was not saved: {reason}",
							store = failure.kind.file_name(),
							reason = failure.reason,
						);
					}
				}
			});
			async {}
		})
		.detach();
	}

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
			let active_session = Some(SessionId::from(view.read(cx).state().current_id.to_string()));
			let now_ms = current_timestamp_ms();
			for intent in &intents {
				for action in actions_for(intent, &host.index, &mut host.store) {
					let kind = action.kind();
					let surface =
						request_surface::surface_for_action(intent, kind, active_session.as_ref());
					let req_id = host.link.send(action);
					host
						.registry
						.register(req_id, kind, surface, now_ms, 30_000);
					view.update(cx, |view, _cx| view.track_submission(req_id, intent));
				}
			}
			view.update(cx, |view, cx| {
				if intents
					.iter()
					.any(|intent| intent.moves_partition() || matches!(intent, Intent::Navigate(_)))
				{
					project(&host.store, &mut host.index, &host.terminals, now_ms, view.state_mut());
				}
				project_controls(&host.store, &host.registry, &host.index, view.state_mut());
				cx.notify();
			});
		})
		.detach();
	}

	// One window-owned clock updates elapsed labels even without host traffic.
	{
		let host = Rc::clone(&host);
		cx.spawn(move |cx: &mut AsyncApp| {
			let mut async_cx = cx.clone();
			async move {
				loop {
					async_cx
						.background_executor()
						.timer(std::time::Duration::from_secs(1))
						.await;
					if window
						.update(&mut async_cx, |view, gpui_window, cx| {
							let mut host = host.borrow_mut();
							let host = &mut *host;
							let now_ms = current_timestamp_ms();
							let changed =
								project_clock(&host.store, &host.index, now_ms, view.state_mut());
							view.set_clock_ms(now_ms);
							host.keep(view, gpui_window, now_ms, cx);
							if changed
								|| matches!(
									view.state().connection,
									veyyon_desktop_surface::attach::ConnectionPhase::Reconnecting { .. }
								) {
								cx.notify();
							}
						})
						.is_err()
					{
						break;
					}
				}
			}
		})
		.detach();
	}
	let mut startup_error = attachment.spawned.err().map(|error| error.to_string());

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
				for event in &batch {
					if let HostEvent::ConnectionChanged(
						veyyon_desktop_model::ConnectionState::Connected { .. },
					) = event
					{
						startup_error = None;
					}
				}
				let startup_notice = startup_error.clone();
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
								let active = (view.state().current_id > 0)
									.then(|| SessionId::from(view.state().current_id.to_string()));
								if let Some(line) =
									land_failure(error, &host.registry, active.as_ref(), view.state_mut())
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
							HostEvent::Snapshot(veyyon_desktop_model::SnapshotSection::Keybindings(
								views,
							)) => {
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
							HostEvent::Snapshot(veyyon_desktop_model::SnapshotSection::QueuedPrompts(
								queued,
							)) => {
								// A dequeue answer carries the text back to the composer that
								// asked for it; a frame for a session the operator has since
								// left leaves the draft in front of them alone.
								if let Some(text) =
									restored_draft(&host.index, view.state().current_id, queued)
								{
									view.set_composed(text.to_owned(), cx);
								}
							},
							_ => {},
						}
						let _damage = reduce(&mut host.store, event);
					}
					if let Some(error) = startup_notice {
						let status = notice
							.flatten()
							.unwrap_or_else(|| "waiting for connection".to_string());
						notice = Some(Some(format!("Host startup: {error}; {status}")));
					}
					// A session the last window had open is reopened once the
					// host has listed what it has, and dropped when the host no
					// longer has it (§8.10).
					if let Some(session) = host
						.keeper
						.as_mut()
						.and_then(|keeper| keeper.resolve_reopen(&mut host.store))
					{
						let now_ms = current_timestamp_ms();
						let surface = SurfaceId::QueueSessionRow(session.clone());
						let action = HostAction::OpenSession { session };
						let kind = action.kind();
						let req_id = host.link.send(action);
						host
							.registry
							.register(req_id, kind, surface, now_ms, 30_000);
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
}
