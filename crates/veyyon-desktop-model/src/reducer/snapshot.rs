use crate::{
	damage::{Damage, DamageSet},
	event::SnapshotSection,
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
		SnapshotSection::Settings(_) => {
			damage.insert(Damage::Titlebar);
		},
		SnapshotSection::Diagnostics(_) => {
			damage.insert(Damage::Titlebar);
		},
	}

	damage
}
