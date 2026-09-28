use crate::{
	connection::ConnectionState,
	damage::{Damage, DamageSet},
	store::Store,
	streaming::{StreamingAppend, StreamingAppendError, StreamingMessageState},
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

/// Reduces text appended to the reply the active session is streaming.
///
/// Only the reply's entry is damaged: an append changes no tool and no run
/// state. An append that does not fit the held reply is a protocol error,
/// reduced as [`super::reduce_fatal_protocol_error`] reduces one the host
/// reports, because drawing it would put text on screen the host never sent.
pub fn reduce_streaming_appended(store: &mut Store, append: StreamingAppend) -> DamageSet {
	let session_id = store
		.persisted
		.shell
		.active_session
		.clone()
		.unwrap_or_else(|| "default".into());
	let applied = match store.streaming.get_mut(&session_id) {
		Some(state) => state.append(&append),
		None => Err(StreamingAppendError::NoStream { entry: append.entry.clone() }),
	};
	let mut damage = DamageSet::new();
	match applied {
		Ok(()) => {
			damage.insert(Damage::TranscriptEntry(session_id, append.entry));
		},
		Err(error) => {
			store.connection = ConnectionState::Fatal { message: error.to_string() };
			damage.insert(Damage::FullWindow);
			damage.insert(Damage::ConnectionLine);
		},
	}
	damage
}
