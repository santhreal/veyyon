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
		SnapshotSection::Settings(_) => {
			damage.insert(Damage::Titlebar);
		},
		SnapshotSection::Diagnostics(_) => {
			damage.insert(Damage::Titlebar);
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
