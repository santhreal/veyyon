//! The application state entity: the model's store, the in-flight request
//! registry, the intent outbox and the client transcript cache.

mod cache;
mod deadline;
mod events;
mod flat;
mod intents;
mod projects;
mod reduce;
// Thread
mod transcript;
// Composer
mod composer;
// Composer
pub use self::composer::{Answer, Decision, DialogAnswer, decisions};
// Panel
mod drawer;
mod panel;
// Panel
pub use self::drawer::StreamMark;
// Sidebar
mod sidebar;
// Palette
mod settings;
// Shell
mod workspace;

use std::{collections::HashMap, time::Instant};

use veyyon_desktop_model::{
	HostEvent, HostRequest, PendingDecisions, PersistedState, RequestId, RequestRegistry, SessionId,
	Store, TranscriptEntry,
};
use veyyon_gpui::{Context, EventEmitter};

pub use self::{
	cache::TRANSCRIPT_CACHE_SESSIONS,
	deadline::{EVICTED, REQUEST_TIMEOUT_MS, UNANSWERED},
	events::StoreEvent,
	projects::{Project, SessionRow},
};
use self::{cache::TranscriptCache, deadline::Deadline, projects::build_projects};

/// The state every desktop view reads, held in one `Entity<AppState>`.
///
/// The transport feeds host events to [`apply`](Self::apply) and sends what
/// [`drain_outbox`](Self::drain_outbox) returns. Views read the store through
/// `app_state.read(cx)` and subscribe to [`StoreEvent`].
pub struct AppState {
	store:        Store,
	registry:     RequestRegistry,
	/// The timer that fails the next request to outlive its deadline, held
	/// while a request is in flight.
	deadline:     Option<Deadline>,
	/// The executor instant the registry's millisecond clock counts from.
	clock_epoch:  Option<Instant>,
	outbox:       Vec<HostRequest>,
	next_request: u64,
	transcripts:  TranscriptCache,
	/// The working directory the host reported for each session.
	cwds:         HashMap<SessionId, String>,
	projects:     Vec<Project>,
	/// The session the window shows. It leads the host's active session
	/// while an `OpenSession` is in flight.
	displayed:    Option<SessionId>,
	/// The `OpenSession` in flight and the session it opens.
	pending_open: Option<(RequestId, SessionId)>,
	// Composer
	/// The prompt each session's last `DequeueQueuedPrompt` handed back, held
	/// until that session's composer takes it.
	restored:     HashMap<SessionId, String>,
	/// The decisions answered and not yet confirmed, by the request that
	/// answered each, put back when the host refuses the answer.
	answering:    HashMap<RequestId, (SessionId, PendingDecisions)>,
	// Panel
	/// How far each terminal's and process's output has run.
	streams:      drawer::DrawerStreams,
}

impl EventEmitter<StoreEvent> for AppState {}

impl AppState {
	/// Creates the state over `store`, usually one holding the persisted
	/// state the last window wrote. The window shows the session the store
	/// records as active.
	pub fn new(store: Store) -> Self {
		let cwds = HashMap::new();
		let projects = build_projects(&store, &cwds);
		Self {
			displayed: store.persisted.shell.active_session.clone(),
			store,
			registry: RequestRegistry::new(),
			deadline: None,
			clock_epoch: None,
			outbox: Vec::new(),
			next_request: 0,
			transcripts: TranscriptCache::default(),
			cwds,
			projects,
			pending_open: None,
			// Composer
			restored: HashMap::new(),
			answering: HashMap::new(),
			// Panel
			streams: drawer::DrawerStreams::default(),
		}
	}

	/// Reduces a batch of host events, emits one [`StoreEvent`] for each
	/// region the batch changed, and points the deadline timer at the next
	/// request still in flight.
	pub fn apply(&mut self, events: Vec<HostEvent>, cx: &mut Context<Self>) {
		for event in self.reduce_batch(events) {
			cx.emit(event);
		}
		self.arm_deadline(cx);
	}

	/// The store the host events were reduced into.
	pub const fn store(&self) -> &Store {
		&self.store
	}

	/// Changes the stores the window writes to disk and emits
	/// [`StoreEvent::Remembered`], which schedules the write. Every change the
	/// window makes to them, rather than a host event, goes through here.
	fn remember<R>(
		&mut self,
		cx: &mut Context<Self>,
		write: impl FnOnce(&mut PersistedState) -> R,
	) -> R {
		let written = write(&mut self.store.persisted);
		cx.emit(StoreEvent::Remembered);
		written
	}

	/// The requests sent and not yet answered.
	pub const fn registry(&self) -> &RequestRegistry {
		&self.registry
	}

	/// The session the window shows.
	pub const fn active_session(&self) -> Option<&SessionId> {
		self.displayed.as_ref()
	}

	/// The sidebar listing, rebuilt when [`StoreEvent::SessionsChanged`] is
	/// emitted.
	pub fn projects(&self) -> &[Project] {
		&self.projects
	}

	/// The working directory the host reported for `session`.
	pub fn cwd(&self, session: &SessionId) -> Option<&str> {
		self.cwds.get(session).map(String::as_str)
	}

	/// The number of entries on the active branch of `session`'s transcript,
	/// 0 for a session the cache does not hold.
	pub fn entry_count(&self, session: &SessionId) -> usize {
		self
			.transcripts
			.get(session)
			.map_or(0, |cached| cached.order.len())
	}

	/// The entry at display index `ix` of `session`'s active branch.
	pub fn entry_at(&self, session: &SessionId, ix: usize) -> Option<&TranscriptEntry> {
		let id = self.transcripts.get(session)?.order.get(ix)?;
		self.store.transcripts.get(session)?.get(id)
	}

	/// Whether the client holds `session`'s transcript, which opening it
	/// renders before the host answers.
	pub fn is_cached(&self, session: &SessionId) -> bool {
		self.transcripts.get(session).is_some()
	}
}
