//! The entity that attaches the window's [`AppState`] to a host: host events
//! reduce into it in batches, the intents it queues go out over the link, and
//! what the window remembers is written as it changes.

use std::time::Duration;

use veyyon_desktop::{Attachment, HostLink, HostStderr, current_timestamp_ms, state::DEBOUNCE_MS};
use veyyon_desktop_app::{
	AppState, StoreEvent,
	workspace::{Workspace, WorkspaceEvent},
};
use veyyon_desktop_model::{ConnectionState, HostEvent, SnapshotSection};
use veyyon_gpui::{App, Context, Entity, Subscription, Task, Window};

use super::keep::Keep;

/// How many of the host's last stderr lines a dropped connection reports.
const HOST_WORDS_LINES: usize = 3;

/// The window's link to its host and its memory.
pub struct Host {
	app:            Entity<AppState>,
	/// Absent until the host is resolved, and when the transport did not
	/// start. Intents queue on `app` meanwhile.
	link:           Option<Linked>,
	keep:           Keep,
	_subscriptions: [Subscription; 4],
}

/// A started transport and the task reducing what it reports.
struct Linked {
	link:    HostLink,
	_events: Task<()>,
}

impl Host {
	/// Follows `app` and `workspace` in `window`: queued intents are sent,
	/// and a change to anything the window remembers schedules a write.
	pub fn new(
		app: Entity<AppState>,
		workspace: &Entity<Workspace>,
		keep: Keep,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Self {
		let store = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
			StoreEvent::OutboxReady => this.send_outbox(cx),
			// A streamed delta changes no store the window remembers.
			StoreEvent::StreamingChanged { .. } | StoreEvent::TranscriptSpliced { .. } => {},
			_ => this.schedule_write(cx),
		});
		// Recording the layout emits `Remembered`, which schedules the write.
		let layout = cx.subscribe(workspace, |this, _, event: &WorkspaceEvent, cx| {
			let WorkspaceEvent::LayoutChanged(layout) = event;
			this.app.update(cx, |app, cx| app.record_layout(layout, cx));
		});
		let bounds = cx.observe_window_bounds(window, |this, window, cx| {
			this.keep.record_bounds(window.window_bounds());
			this.schedule_write(cx);
		});
		let quit = cx.on_app_quit(|this, cx| {
			this.write_now(cx);
			async {}
		});
		// A closed window writes what the debounce still holds.
		cx.on_release(|this, cx| this.write_now(cx)).detach();
		Self { app, link: None, keep, _subscriptions: [store, layout, bounds, quit] }
	}

	/// Reduces `state` as the connection's, for the states the window
	/// reaches before a transport reports one: resolving the host, and
	/// failing to.
	pub fn connection(&self, state: ConnectionState, cx: &mut App) {
		self
			.app
			.update(cx, |app, cx| app.apply(vec![HostEvent::ConnectionChanged(state)], cx));
	}

	/// Starts the transport to the resolved host, sends what queued while
	/// it was resolved, and reduces what it reports in batches: everything
	/// already queued is drained before one apply, so a burst of streamed
	/// deltas costs one reduce, not one each.
	pub fn attach(&mut self, attachment: &Attachment, cx: &mut Context<Self>) {
		let (link, mut events) = match HostLink::start(attachment.endpoint.clone()) {
			Ok(started) => started,
			Err(error) => {
				let message = format!("the transport did not start: {error}");
				self.connection(ConnectionState::Fatal { message }, cx);
				return;
			},
		};
		let mut words = HostWords::new(attachment);
		// Weak: a task idle at shutdown is dropped after the entities are, and a
		// strong handle in it would outlive them.
		let app = self.app.downgrade();
		let reduce = cx.spawn(async move |_, cx| {
			// The session the last window displayed is asked for once, when the
			// host's first session list says whether it still has it.
			let mut reopen = true;
			while let Some(first) = events.recv().await {
				let mut batch = vec![first];
				while let Ok(event) = events.try_recv() {
					batch.push(event);
				}
				words.enrich(&mut batch);
				let listed = reopen
					&& batch
						.iter()
						.any(|event| matches!(event, HostEvent::Snapshot(SnapshotSection::Sessions(..))));
				let applied = app.update(cx, |app, cx| {
					app.apply(batch, cx);
					if listed {
						app.reopen_remembered(cx);
					}
				});
				if applied.is_err() {
					break;
				}
				reopen &= !listed;
			}
		});
		self.link = Some(Linked { link, _events: reduce });
		self.send_outbox(cx);
	}

	/// Sends every queued intent, once a link exists.
	fn send_outbox(&self, cx: &mut Context<Self>) {
		let Some(Linked { link, .. }) = self.link.as_ref() else {
			return;
		};
		for request in self.app.update(cx, |app, _| app.drain_outbox()) {
			link.forward(request);
		}
	}

	/// Writes one debounce window from now, unless a write is already due.
	fn schedule_write(&mut self, cx: &Context<Self>) {
		if !self.keep.schedule() {
			return;
		}
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(Duration::from_millis(DEBOUNCE_MS))
				.await;
			let _ = this.update(cx, |this, cx| this.write_now(cx));
		})
		.detach();
	}

	fn write_now(&mut self, cx: &App) {
		self
			.keep
			.write(&self.app.read(cx).store().persisted, current_timestamp_ms());
	}
}

/// What a host this window started said, appended to the message of a
/// connection that dropped: the host's stderr tail, or the error its startup
/// ended in. Without it a drop reports the symptom and discards the cause.
struct HostWords {
	stderr:  Option<HostStderr>,
	startup: Option<String>,
}

impl HostWords {
	fn new(attachment: &Attachment) -> Self {
		match &attachment.spawned {
			Ok(child) => {
				Self { stderr: child.as_ref().map(|child| child.stderr.clone()), startup: None }
			},
			Err(error) => Self { stderr: None, startup: Some(error.to_string()) },
		}
	}

	fn enrich(&mut self, batch: &mut [HostEvent]) {
		for event in batch {
			let HostEvent::ConnectionChanged(state) = event else {
				continue;
			};
			match state {
				ConnectionState::Connected { .. } => self.startup = None,
				ConnectionState::Reconnecting { message, .. } | ConnectionState::Fatal { message } => {
					let words = self
						.stderr
						.as_ref()
						.and_then(|stderr| stderr.last_words(HOST_WORDS_LINES))
						.or_else(|| self.startup.clone());
					if let Some(words) = words {
						message.push_str(": ");
						message.push_str(&words);
					}
				},
				_ => {},
			}
		}
	}
}
