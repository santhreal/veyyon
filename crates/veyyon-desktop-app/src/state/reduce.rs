//! Batch reduction: host events into the store, damage into typed events.

use std::ops::Range;

use veyyon_desktop_model::{
	Damage, DamageSet, EntryId, HostEvent, RequestId, SessionId, SnapshotSection,
	SnapshotSectionKind, reduce,
};

use super::{
	AppState, StoreEvent,
	flat::{DisplayOrder, SpliceWindow},
	projects::build_projects,
};

/// How a batch leaves one session's display order.
enum Pending {
	Splice(SpliceWindow),
	Reset,
}

/// What one batch changed, gathered before anything is emitted.
#[derive(Default)]
pub(super) struct Batch {
	events:            Vec<StoreEvent>,
	/// The damage of every transcript append and update in the batch. Its
	/// coarsening turns more than 32 entry changes of one session into a
	/// reset.
	transcript_damage: DamageSet,
	transcripts:       Vec<(SessionId, Pending)>,
	sessions:          bool,
}

impl Batch {
	fn push(&mut self, event: StoreEvent) {
		if !self.events.contains(&event) {
			self.events.push(event);
		}
	}

	fn note(&mut self, damage: &DamageSet) {
		if damage.contains(&Damage::Notifications) || damage.contains(&Damage::FullWindow) {
			self.push(StoreEvent::NotificationsChanged);
		}
	}

	fn pending(&mut self, session: &SessionId) -> Option<&mut Pending> {
		self.transcripts
			.iter_mut()
			.find(|(held, _)| held == session)
			.map(|(_, pending)| pending)
	}

	fn reset(&mut self, session: &SessionId) {
		match self.pending(session) {
			Some(pending) => *pending = Pending::Reset,
			None => self.transcripts.push((session.clone(), Pending::Reset)),
		}
	}

	fn splice(&mut self, session: &SessionId, range: &Range<usize>, len_before: usize) {
		match self.pending(session) {
			Some(Pending::Reset) => {},
			Some(Pending::Splice(window)) => window.record(range, len_before),
			None => self
				.transcripts
				.push((session.clone(), Pending::Splice(SpliceWindow::new(range, len_before)))),
		}
	}
}

/// What a snapshot section changes besides the store.
enum Follow {
	Sessions,
	Header(SessionId),
	Transcript(u64),
	Interactions(SessionId),
	Domain(SnapshotSectionKind),
}

impl AppState {
	/// Reduces a batch of host events into the store and returns the events
	/// [`apply`](Self::apply) emits, each distinct event once and only for
	/// what changed.
	pub fn reduce_batch(&mut self, events: Vec<HostEvent>) -> Vec<StoreEvent> {
		let mut batch = Batch::default();
		for event in events {
			self.reduce_event(event, &mut batch);
		}
		self.finish(batch)
	}

	fn reduce_event(&mut self, event: HostEvent, batch: &mut Batch) {
		match event {
			HostEvent::Snapshot(section) => self.reduce_section(section, batch),
			HostEvent::TranscriptAppended { revision, entries } => {
				let event = HostEvent::TranscriptAppended { revision, entries };
				self.reduce_transcript(event, revision, None, batch);
			},
			HostEvent::TranscriptUpdated { revision, entry } => {
				let id = entry.id.clone();
				let event = HostEvent::TranscriptUpdated { revision, entry };
				self.reduce_transcript(event, revision, Some(&id), batch);
			},
			HostEvent::StreamingChanged(stream) => {
				let damage = reduce(&mut self.store, HostEvent::StreamingChanged(stream));
				if let Some(session) = damaged_session(&damage) {
					batch.push(StoreEvent::StreamingChanged { session });
				}
			},
			// A view draws an append as a change to the reply it already
			// holds; one that does not fit the held reply fails the
			// connection, which the connection line states.
			HostEvent::StreamingAppended(append) => {
				let damage = reduce(&mut self.store, HostEvent::StreamingAppended(append));
				batch.note(&damage);
				match damaged_session(&damage) {
					Some(session) => batch.push(StoreEvent::StreamingChanged { session }),
					None => batch.push(StoreEvent::ConnectionChanged),
				}
			},
			HostEvent::RequestSucceeded { request } => {
				self.registry.complete(&request);
				batch.note(&reduce(&mut self.store, HostEvent::RequestSucceeded { request }));
				self.settle_open(request, true, batch);
				self.settle_answer(request, true);
				self.settle_branch(request, true);
				batch.push(StoreEvent::RequestFinished { request, ok: true });
			},
			HostEvent::RequestFailed { request, error } => {
				self.registry.complete(&request);
				batch.note(&reduce(&mut self.store, HostEvent::RequestFailed { request, error }));
				self.settle_open(request, false, batch);
				self.settle_branch(request, false);
				if let Some(session) = self.settle_answer(request, false) {
					batch.push(StoreEvent::InteractionsChanged { session });
				}
				batch.push(StoreEvent::RequestFinished { request, ok: false });
			},
			HostEvent::ConnectionChanged(state) => {
				let changed = self.store.connection != state;
				batch.note(&reduce(&mut self.store, HostEvent::ConnectionChanged(state)));
				if changed {
					batch.push(StoreEvent::ConnectionChanged);
				}
			},
			HostEvent::FatalProtocolError { message } => {
				let damage = reduce(&mut self.store, HostEvent::FatalProtocolError { message });
				batch.note(&damage);
				if !damage.is_empty() {
					batch.push(StoreEvent::ConnectionChanged);
				}
			},
		}
	}

	fn reduce_section(&mut self, section: SnapshotSection, batch: &mut Batch) {
		let follow = match &section {
			SnapshotSection::Sessions(listing, _) => {
				self.cwds = listing
					.value
					.iter()
					.map(|summary| (summary.id.clone(), summary.cwd.clone()))
					.collect();
				Follow::Sessions
			},
			SnapshotSection::ActiveSession(header) => {
				let id = header.value.id.clone();
				self.cwds.insert(id.clone(), header.value.cwd.clone());
				Follow::Header(id)
			},
			SnapshotSection::Transcript(transcript) => Follow::Transcript(transcript.revision),
			SnapshotSection::Interactions { session, .. } => Follow::Interactions(session.clone()),
			// Composer
			SnapshotSection::QueuedPrompts(view) => {
				self.note_restored(view);
				Follow::Domain(SnapshotSectionKind::from(&section))
			},
			// Panel
			SnapshotSection::TerminalOutput(chunk) => {
				self.note_terminal_output(chunk);
				Follow::Domain(SnapshotSectionKind::TerminalOutput)
			},
			SnapshotSection::ProcessLogs(chunk) => {
				self.note_process_logs(chunk);
				Follow::Domain(SnapshotSectionKind::ProcessLogs)
			},
			other => Follow::Domain(SnapshotSectionKind::from(other)),
		};
		let damage = reduce(&mut self.store, HostEvent::Snapshot(section));
		batch.note(&damage);
		match follow {
			Follow::Sessions => batch.sessions = true,
			Follow::Header(session) => {
				// A header renames the session and marks it read.
				batch.sessions = true;
				batch.push(StoreEvent::DomainChanged(SnapshotSectionKind::ActiveSession));
				self.follow_host(session, batch);
			},
			Follow::Transcript(revision) => {
				if let Some(session) = damaged_session(&damage) {
					self.settle_transcript(&session, revision, batch);
				}
			},
			Follow::Interactions(session) => {
				self.forget_answers(&session);
				batch.push(StoreEvent::InteractionsChanged { session });
			},
			Follow::Domain(kind) => batch.push(StoreEvent::DomainChanged(kind)),
		}
	}

	fn reduce_transcript(
		&mut self,
		event: HostEvent,
		revision: u64,
		updated: Option<&EntryId>,
		batch: &mut Batch,
	) {
		let damage = reduce(&mut self.store, event);
		batch.note(&damage);
		if let Some(session) = damaged_session(&damage) {
			self.touch(&session);
			if let (Some(tree), Some(cached)) =
				(self.store.transcripts.get(&session), self.transcripts.get_mut(&session))
			{
				cached.revision = Some(cached.revision.map_or(revision, |held| held.max(revision)));
				let len_before = cached.order.len();
				let range = match updated {
					Some(id) => cached.order.position(id).map(|ix| ix..ix + 1),
					None => cached.order.follow_leaf(tree),
				};
				if let Some(range) = range {
					batch.splice(&session, &range, len_before);
				}
			}
		}
		batch.transcript_damage.extend(damage);
	}

	/// Replaces the display order of `session` from the transcript the host
	/// sent whole. A revision and order equal to the cached ones change
	/// nothing on screen and emit nothing.
	fn settle_transcript(&mut self, session: &SessionId, revision: u64, batch: &mut Batch) {
		self.touch(session);
		let (Some(tree), Some(cached)) =
			(self.store.transcripts.get(session), self.transcripts.get_mut(session))
		else {
			return;
		};
		let order = DisplayOrder::rebuild(tree);
		let unchanged = cached.revision == Some(revision) && cached.order.ids() == order.ids();
		cached.order = order;
		cached.revision = Some(revision);
		if !unchanged {
			batch.reset(session);
		}
	}

	/// Follows a session the host made active, unless an `OpenSession` for
	/// another session is still in flight.
	fn follow_host(&mut self, session: SessionId, batch: &mut Batch) {
		if let Some((_, wanted)) = &self.pending_open {
			if wanted != &session {
				return;
			}
			self.pending_open = None;
		}
		self.show(session, batch);
	}

	/// Ends the in-flight `OpenSession` answered by `request`. A refused one
	/// returns the window to the session the host holds active.
	fn settle_open(&mut self, request: RequestId, ok: bool, batch: &mut Batch) {
		if self
			.pending_open
			.as_ref()
			.is_none_or(|(sent, _)| *sent != request)
		{
			return;
		}
		self.pending_open = None;
		let fallback = if ok { None } else { self.store.persisted.shell.active_session.clone() };
		if let Some(active) = fallback {
			self.show(active, batch);
		}
	}

	/// Shows `session`, rendering whatever the cache holds of it.
	pub(super) fn show(&mut self, session: SessionId, batch: &mut Batch) {
		if self.displayed.as_ref() == Some(&session) {
			return;
		}
		self.displayed = Some(session.clone());
		self.touch(&session);
		batch.push(StoreEvent::ActiveSessionChanged);
		batch.reset(&session);
	}

	/// Marks `session` most recently used, dropping the transcript of the
	/// session evicted to make room.
	fn touch(&mut self, session: &SessionId) {
		if let Some(evicted) = self.transcripts.touch(session, self.displayed.as_ref()) {
			self.store.transcripts.remove(&evicted);
		}
	}

	pub(super) fn finish(&mut self, mut batch: Batch) -> Vec<StoreEvent> {
		if batch.sessions {
			let projects = build_projects(&self.store, &self.cwds);
			if projects != self.projects {
				self.projects = projects;
				batch.push(StoreEvent::SessionsChanged);
			}
		}
		let coarse = batch.transcript_damage.contains(&Damage::FullWindow);
		for (session, pending) in std::mem::take(&mut batch.transcripts) {
			let full = coarse
				|| batch
					.transcript_damage
					.contains(&Damage::TranscriptFull(session.clone()));
			match pending {
				Pending::Splice(window) if !full => {
					let (range, count) = window.finish(self.entry_count(&session));
					if !range.is_empty() || count > 0 {
						batch.push(StoreEvent::TranscriptSpliced { session, range, count });
					}
				},
				_ => batch.push(StoreEvent::TranscriptReset { session }),
			}
		}
		batch.events
	}
}

/// The session a transcript or streaming reduction filed its change under.
fn damaged_session(damage: &DamageSet) -> Option<SessionId> {
	damage.iter().find_map(|item| match item {
		Damage::RunBar(session)
		| Damage::TranscriptEntry(session, _)
		| Damage::TranscriptSpan(session, _)
		| Damage::TranscriptFull(session) => Some(session.clone()),
		_ => None,
	})
}
