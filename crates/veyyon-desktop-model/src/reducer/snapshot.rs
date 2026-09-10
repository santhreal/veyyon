use std::collections::HashSet;

use crate::{
	connection::{InteractionId, SessionId},
	damage::{Damage, DamageSet},
	domain::QueuedPrompts,
	event::{SessionSummary, SnapshotSection},
	interaction::PendingDecisions,
	session::{QueuePartition, Session, SessionMode},
	store::Store,
	transcript::TranscriptTree,
};

/// Reduces the host's session index, which is every session the host holds.
///
/// The partition a session sits in, the park, defer and pin timestamps, and the
/// anchor those set are the client's state: the operator parks a session here
/// and the host is never told. A re-listing therefore updates what the file
/// says about a session already held and leaves the rest of it alone.
/// Rebuilding each session from the summary instead returns every parked,
/// deferred and pinned session to `Live` the next time any session is created,
/// renamed or deleted, since each of those sends the whole index again.
///
/// The status and the last write are what the file says, so a re-listing takes
/// both: they are the row badge's inputs (`badge::session_badge`) and neither
/// orders a partition. The read mark moves with them for the session the
/// operator has open and for one seen for the first time, so a turn that ends
/// under the operator's eyes raises no attention and attaching to a host
/// holding finished sessions raises none either.
///
/// A session the index no longer lists is gone with its file and is dropped,
/// along with the transcript held for it. Dropping the one the window is on
/// also clears the active pointer, so nothing addresses a session the host no
/// longer holds.
fn reduce_session_index(store: &mut Store, summaries: Vec<SessionSummary>) {
	let active = store.persisted.shell.active_session.clone();
	let mut listed: HashSet<SessionId> = HashSet::with_capacity(summaries.len());
	for summary in summaries {
		let id = summary.id.clone();
		listed.insert(id.clone());
		let title = summary
			.title
			.filter(|t| !t.trim().is_empty())
			.unwrap_or_else(|| "new session".to_string());
		if let Some(known) = store.sessions.get_mut(&id) {
			// `created_at_ms` and `last_recall_at_ms` are the Live anchor, and
			// §5.2 re-anchors on unpark, recall and pin alone. A session that
			// received a message has a newer `modified_at_ms`, so reading it
			// as the anchor would reorder the partition on activity.
			known.title = title;
			known.project_name = summary.workspace;
			known.status = summary.status;
			known.modified_at_ms = summary.modified_at_ms;
			if active.as_ref() == Some(&id) {
				known.read_mark_ms = Some(summary.modified_at_ms);
			}
			continue;
		}
		store.sessions.insert(Session {
			id,
			title,
			project_name: summary.workspace,
			branch: String::new(),
			partition: QueuePartition::Live,
			status: summary.status,
			created_at_ms: summary.created_at_ms,
			modified_at_ms: summary.modified_at_ms,
			read_mark_ms: Some(summary.modified_at_ms),
			last_recall_at_ms: summary.modified_at_ms,
			defer_until_ms: None,
			parked_at_ms: None,
			pin_key: None,
		});
	}

	let dropped: Vec<SessionId> = store
		.sessions
		.items
		.iter()
		.filter(|(id, _)| !listed.contains(*id))
		.map(|(id, _)| id.clone())
		.collect();
	for id in dropped {
		store.sessions.remove(&id);
		store.transcripts.remove(&id);
		// A session the host no longer holds cannot be the one the window is
		// on: leaving the pointer would address a deleted session with the
		// next prompt and file the next transcript under it.
		if store.persisted.shell.active_session.as_ref() == Some(&id) {
			store.persisted.shell.active_session = None;
		}
	}
}

/// Applies the active session's own header to the row the queue draws.
///
/// The header is the only section that reports a rename of the open session:
/// the host re-sends the whole index on create, rename and delete, but a title
/// the model authored mid-turn arrives here first, and dropping it left the
/// titlebar and the rail on the previous name until the next listing.
///
/// The title is all it carries that the queue draws. The index is the sole
/// authority on which sessions exist and on the workspace name, so a header
/// naming a session the index has not listed yet selects it and adds no row;
/// the listing that follows brings one. `created_at_ms` anchors the Live order
/// and §5.2 re-anchors on unpark, recall and pin alone, so it is not read here
/// for the same reason `reduce_session_index` does not re-read it.
///
/// Opening a session reads it: the header arrives when the operator opens one,
/// so the read mark takes the last write the index reported and the `Done`,
/// `Due` and `Failed` badges (§0) come off the row.
fn reduce_active_header(store: &mut Store, id: &SessionId, title: Option<String>) {
	let Some(known) = store.sessions.get_mut(id) else {
		return;
	};
	known.title = title
		.filter(|t| !t.trim().is_empty())
		.unwrap_or_else(|| "new session".to_string());
	known.read_mark_ms = Some(known.modified_at_ms);
}

/// Reduces a full or partial snapshot synchronization section into store state.
pub fn reduce_snapshot(store: &mut Store, snapshot: SnapshotSection) -> DamageSet {
	let mut damage = DamageSet::new();

	match snapshot {
		SnapshotSection::Sessions(versioned, _errors) => {
			reduce_session_index(store, versioned.value);
			damage.insert(Damage::QueueAll);
		},
		SnapshotSection::ActiveSession(versioned) => {
			let header = versioned.value;
			let session_id = header.id;
			reduce_active_header(store, &session_id, header.title);
			// A header that names no mode is a session in none of them, so the
			// entry is removed rather than left at whatever the last header
			// said: a mode the operator has just left would otherwise keep
			// being stated.
			match header.mode.as_deref().and_then(SessionMode::from_wire) {
				Some(mode) => store.modes.insert(session_id.clone(), mode),
				None => store.modes.remove(&session_id),
			};
			store.persisted.shell.active_session = Some(session_id.clone());
			damage.insert(Damage::QueueAll);
			damage.insert(Damage::Titlebar);
			damage.insert(Damage::Composer(session_id.clone()));
			damage.insert(Damage::RightPanelChrome(session_id));
		},
		SnapshotSection::Transcript(versioned) => {
			let active_session = store
				.persisted
				.shell
				.active_session
				.clone()
				.unwrap_or_else(|| "default".into());
			// A snapshot is the whole transcript as the host holds it. Reopening
			// a session sends one again, so it replaces the tree rather than
			// appending to it, or every reopen would double the transcript.
			let mut tree = TranscriptTree::new();
			for entry in versioned.value {
				tree.append(entry);
			}
			store.transcripts.insert(active_session.clone(), tree);
			damage.insert(Damage::TranscriptFull(active_session));
		},
		SnapshotSection::Capabilities(caps) => {
			for (cap, status) in caps {
				store.capabilities.set(cap, status);
			}
			damage.insert(Damage::Titlebar);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::Composer(session_id.clone()));
			}
		},
		SnapshotSection::Interactions { session, pending } => {
			// Damage names every card that was or is on screen: a card that was
			// answered has to be taken down as surely as a new one is drawn.
			let previous = if pending.is_empty() {
				store.interactions.remove(&session)
			} else {
				store.interactions.insert(session.clone(), pending)
			};
			let mut ids: Vec<_> = previous.iter().flat_map(decision_ids).collect();
			ids.extend(
				store
					.interactions
					.get(&session)
					.into_iter()
					.flat_map(decision_ids),
			);
			for id in ids {
				damage.insert(Damage::PendingDecision(session.clone(), id));
			}
			damage.insert(Damage::Composer(session));
		},
		SnapshotSection::Settings(val) => {
			store.domains.settings = Some(val);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Diagnostics(val) => {
			store.domains.diagnostics = Some(val);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Changes(view) => {
			store.domains.changes.set(view);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::RightPanelTab(session_id.clone(), "changes".to_string()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::FileTree(view) => {
			store.domains.file_tree = Some(view);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::RightPanelTab(session_id.clone(), "filetree".to_string()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::FileContent(view) => {
			store.domains.file_content.set(view);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::RightPanelTab(session_id.clone(), "filecontent".to_string()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::SearchResults(view) => {
			store.domains.search = Some(view);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::RightPanelTab(session_id.clone(), "searchresults".to_string()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		// The lines a content search matched are rows of the palette that
		// asked for them, which floats over the whole window.
		SnapshotSection::ContentMatches(view) => {
			store.domains.content_matches = Some(view);
			damage.insert(Damage::FullWindow);
		},
		SnapshotSection::Terminals(views) => {
			store.domains.terminals = views;
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::TerminalDrawerChrome(session_id.clone()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::TerminalOutput(chunk) => {
			let terminal_id = chunk.terminal.clone();
			store
				.domains
				.terminal_output
				.entry(terminal_id.clone())
				.or_default()
				.append_chunk(chunk);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::TerminalOutput(session_id.clone(), terminal_id));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::Processes(views) => {
			store.domains.processes = views;
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::ProcessList(session_id.clone()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::ProcessLogs(chunk) => {
			let process = chunk.process.clone();
			store
				.domains
				.process_logs
				.entry(process)
				.or_default()
				.append_chunk(chunk);
			if let Some(session_id) = &store.persisted.shell.active_session {
				damage.insert(Damage::ProcessList(session_id.clone()));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::Models(view) => {
			store.domains.models = Some(view);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Providers(views) => {
			store.domains.providers = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::AuthFlow(view) => {
			store.domains.auth_flow = Some(view);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Mcp(views) => {
			store.domains.mcp = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Agents(views) => {
			store.domains.agents = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Usage(view) => {
			let session = view.session;
			store.domains.usage.insert(session.clone(), view.totals);
			damage.insert(Damage::RightPanelTab(session, "usage".to_string()));
		},
		SnapshotSection::ContextBreakdown(view) => {
			let session = view.session.clone();
			store.domains.context.insert(session.clone(), view);
			damage.insert(Damage::RightPanelTab(session, "contextbreakdown".to_string()));
		},
		SnapshotSection::Export(view) => {
			let session = view.session.clone();
			store.domains.export.set(view);
			damage.insert(Damage::RightPanelTab(session, "export".to_string()));
		},
		SnapshotSection::Themes(view) => {
			store.domains.themes = Some(view);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Keybindings(views) => {
			store.domains.keybindings = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::QueuedPrompts(view) => {
			// `restored` is the host's answer to a `DequeueQueuedPrompt`, which
			// belongs to the window's draft rather than the store: keeping it
			// would refill the draft on every later frame.
			let held = QueuedPrompts::from(&view);
			if held.is_empty() {
				store.queued.remove(&view.session);
			} else {
				store.queued.insert(view.session.clone(), held);
			}
			damage.insert(Damage::Composer(view.session));
		},
	}

	damage
}

fn decision_ids(pending: &PendingDecisions) -> impl Iterator<Item = InteractionId> + '_ {
	pending
		.approvals
		.iter()
		.map(|a| a.id.clone())
		.chain(pending.questions.iter().map(|q| q.id.clone()))
		.chain(pending.plans.iter().map(|p| p.id.clone()))
}
