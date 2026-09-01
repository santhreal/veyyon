pub mod connection;
pub mod fatal;
pub mod request;
pub mod snapshot;
pub mod streaming;
pub mod transcript;

pub use self::{
	connection::reduce_connection,
	fatal::reduce_fatal_protocol_error,
	request::{reduce_request_failed, reduce_request_succeeded},
	snapshot::reduce_snapshot,
	streaming::reduce_streaming_changed,
	transcript::{reduce_transcript_appended, reduce_transcript_updated},
};
use crate::{damage::DamageSet, event::HostEvent, store::Store};

/// Pure entry point executing state transitions and returning precise damage
/// descriptions.
pub fn reduce(store: &mut Store, event: HostEvent) -> DamageSet {
	match event {
		HostEvent::ConnectionChanged(state) => reduce_connection(store, state),
		HostEvent::Snapshot(snapshot) => reduce_snapshot(store, snapshot),
		HostEvent::TranscriptAppended { revision, entries } => {
			reduce_transcript_appended(store, revision, entries)
		},
		HostEvent::TranscriptUpdated { revision, entry } => {
			reduce_transcript_updated(store, revision, entry)
		},
		HostEvent::StreamingChanged(stream) => reduce_streaming_changed(store, stream),
		HostEvent::RequestSucceeded { request } => reduce_request_succeeded(store, request),
		HostEvent::RequestFailed { request, error } => reduce_request_failed(store, request, error),
		HostEvent::FatalProtocolError { message } => reduce_fatal_protocol_error(store, message),
	}
}
