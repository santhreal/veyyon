use crate::{
	damage::{Damage, DamageSet},
	store::Store,
	transcript::TranscriptEntry,
};

/// Reduces an append event adding one or more transcript entries to the active
/// session.
pub fn reduce_transcript_appended(
	store: &mut Store,
	_revision: u64,
	entries: Vec<TranscriptEntry>,
) -> DamageSet {
	let mut damage = DamageSet::new();
	let session_id = store
		.persisted
		.shell
		.active_session
		.clone()
		.unwrap_or_else(|| "default".into());

	let tree = store.transcripts.entry(session_id.clone()).or_default();

	for entry in entries {
		let entry_id = entry.id.clone();
		tree.append(entry);
		damage.insert(Damage::TranscriptEntry(session_id.clone(), entry_id));
	}

	damage.insert(Damage::QueueRow(session_id.clone()));
	damage.insert(Damage::RunBar(session_id));
	damage
}

/// Reduces an update event modifying a single transcript entry in place.
pub fn reduce_transcript_updated(
	store: &mut Store,
	_revision: u64,
	entry: TranscriptEntry,
) -> DamageSet {
	let mut damage = DamageSet::new();
	let session_id = store
		.persisted
		.shell
		.active_session
		.clone()
		.unwrap_or_else(|| "default".into());

	let tree = store.transcripts.entry(session_id.clone()).or_default();

	let entry_id = entry.id.clone();
	tree.update(entry);
	damage.insert(Damage::TranscriptEntry(session_id, entry_id));
	damage
}
