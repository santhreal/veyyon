//! Request lookup that never substitutes a different pending interaction.

use veyyon_gui_core::{
	Store,
	model::{InteractionId, InteractionRequest, RemoteData},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestState<'a> {
	Loading,
	Ready(&'a InteractionRequest),
	Stale(&'a InteractionRequest, String),
	Missing,
	Error { message: &'a str, retryable: bool },
}

pub fn request<'a>(store: &'a Store, id: &InteractionId) -> RequestState<'a> {
	match &store.replica.interactions {
		RemoteData::Unrequested | RemoteData::Loading { .. } => RequestState::Loading,
		RemoteData::Empty => RequestState::Missing,
		RemoteData::Ready(versioned) => versioned
			.value
			.iter()
			.find(|request| &request.id == id)
			.map(RequestState::Ready)
			.unwrap_or(RequestState::Missing),
		RemoteData::Stale { value, reason } => value
			.value
			.iter()
			.find(|request| &request.id == id)
			.map(|request| RequestState::Stale(request, format!("{reason:?}")))
			.unwrap_or(RequestState::Missing),
		RemoteData::Error { message, retryable, stale } => stale
			.as_ref()
			.and_then(|versioned| versioned.value.iter().find(|request| &request.id == id))
			.map(|request| RequestState::Stale(request, message.clone()))
			.unwrap_or(RequestState::Error { message, retryable: *retryable }),
	}
}
