mod sessions;

use self::sessions::{reduce_active_header, reduce_session_index};
use super::announce::{announce_decisions_out_of_view, decision_ids, decision_prefix};
use crate::{
	damage::{Damage, DamageSet},
	domain::QueuedPrompts,
	event::SnapshotSection,
	session::SessionMode,
	store::Store,
	transcript::TranscriptTree,
};

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
			// The session is in front of the operator now, so what it was
			// waiting for is read rather than announced.
			if store
				.notifications
				.dismiss_prefix(&decision_prefix(&session_id))
				> 0
			{
				damage.insert(Damage::Notifications);
			}
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
		SnapshotSection::SessionSearch(view) => {
			store.domains.session_search = Some(view);
			damage.insert(Damage::Titlebar);
		},
		SnapshotSection::SessionTranscript(view) => {
			store.domains.session_preview = Some(view);
			damage.insert(Damage::Titlebar);
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
			if store.persisted.shell.active_session.as_ref() != Some(&session) {
				announce_decisions_out_of_view(
					&mut store.notifications,
					&session,
					previous.as_ref(),
					store.interactions.get(&session),
				);
				damage.insert(Damage::Notifications);
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
		// The prompts a history lookup matched are rows of the palette that
		// asked for them, which floats over the whole window.
		SnapshotSection::PromptHistory(view) => {
			store.domains.prompt_history = Some(view);
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
		SnapshotSection::AgentComms(views) => {
			store.domains.agent_comms = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Share(view) => {
			store.domains.share = Some(view);
			damage.insert(Damage::Palette);
		},
		SnapshotSection::Profiles(view) => {
			store.domains.profiles = Some(view);
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
		SnapshotSection::Commands(views) => {
			store.domains.commands = views;
			damage.insert(Damage::Palette);
		},
		SnapshotSection::AgentPause(view) => {
			// The freeze is the host's, so the section replaces what the window
			// holds rather than toggling it: a window that attaches mid-pause
			// and a window that engaged the pause itself reach the same value.
			store.paused = view;
			// The strip takes a band off the top for as long as it holds, so
			// its arrival and its departure move every region under it.
			damage.insert(Damage::FullWindow);
		},
		SnapshotSection::Goal { session, goal } => {
			if let Some(goal) = goal {
				store.goals.insert(session.clone(), goal);
			} else {
				store.goals.remove(&session);
			}
			damage.insert(Damage::Composer(session));
		},
		SnapshotSection::Dictation(view) => {
			// The microphone belongs to the window, so the section carries no
			// session and the composer of the active session is what redraws.
			store.domains.dictation = Some(view);
			if let Some(session) = store.persisted.shell.active_session.clone() {
				damage.insert(Damage::Composer(session));
			} else {
				damage.insert(Damage::FullWindow);
			}
		},
		SnapshotSection::ForegroundCommand { session, command } => {
			// The control sits in that session's composer, so only its band
			// redraws: another session's command starting or finishing leaves
			// this one alone.
			if let Some(command) = command {
				store.domains.foreground.insert(session.clone(), command);
			} else {
				store.domains.foreground.remove(&session);
			}
			damage.insert(Damage::Composer(session));
		},
	}

	damage
}
