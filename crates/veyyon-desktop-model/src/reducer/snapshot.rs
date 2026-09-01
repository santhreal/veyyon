use crate::{
	connection::InteractionId,
	damage::{Damage, DamageSet},
	event::SnapshotSection,
	interaction::PendingDecisions,
	session::{QueuePartition, Session},
	store::Store,
	transcript::TranscriptTree,
};

/// Reduces a full or partial snapshot synchronization section into store state.
pub fn reduce_snapshot(store: &mut Store, snapshot: SnapshotSection) -> DamageSet {
	let mut damage = DamageSet::new();

	match snapshot {
		SnapshotSection::Sessions(versioned, _errors) => {
			for summary in versioned.value {
				let id = summary.id.clone();
				let session = Session {
					id:                id.clone(),
					title:             summary.title.unwrap_or_else(|| summary.path.clone()),
					project_name:      summary.workspace,
					branch:            String::new(),
					partition:         QueuePartition::Live,
					badge:             None,
					created_at_ms:     summary.created_at_ms,
					last_recall_at_ms: summary.modified_at_ms,
					defer_until_ms:    None,
					parked_at_ms:      None,
					pin_key:           None,
				};
				store.sessions.insert(session);
			}
			damage.insert(Damage::QueueAll);
		},
		SnapshotSection::ActiveSession(versioned) => {
			let header = versioned.value;
			let session_id = header.id;
			store.persisted.shell.active_session = Some(session_id.clone());
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
			store.domains.changes = Some(view);
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
			store.domains.file_content = Some(view);
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
		SnapshotSection::McpToolResult(view) => {
			store.domains.mcp_tool_result = Some(view);
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
			store.domains.export = Some(view);
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
