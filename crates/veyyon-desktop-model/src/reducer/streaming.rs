use crate::{
	damage::{Damage, DamageSet},
	store::Store,
	streaming::StreamingMessageState,
};

/// Reduces an incoming streaming message update or completion event.
pub fn reduce_streaming_changed(
	store: &mut Store,
	stream: Option<StreamingMessageState>,
) -> DamageSet {
	let mut damage = DamageSet::new();
	let session_id = store
		.persisted
		.shell
		.active_session
		.clone()
		.unwrap_or_else(|| "default".into());

	if let Some(state) = stream {
		let entry_id = state.entry.clone();
		store.streaming.insert(session_id.clone(), state);
		damage.insert(Damage::TranscriptEntry(session_id.clone(), entry_id));
	} else {
		store.streaming.remove(&session_id);
	}
	damage.insert(Damage::RunBar(session_id));

	damage
}
