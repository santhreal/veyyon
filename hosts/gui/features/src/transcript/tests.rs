//! Timeline state tests cover stale readability, end-follow, and row splicing.

use veyyon_gui_core::model::{ConnectionState, RemoteData, RequestId, StaleReason, Versioned};

use super::logic::{
	FollowEvent, FollowState, RowTransition, SurfaceState, loading_progress, row_transition, surface,
};

fn ready(values: Vec<u8>) -> RemoteData<Versioned<Vec<u8>>> {
	RemoteData::Ready(Versioned { revision: 1, value: values })
}

#[test]
fn every_remote_state_has_an_explicit_surface_state() {
	let connection = ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 };
	let request = RequestId::new(1).expect("nonzero request");
	let states = [
		RemoteData::Unrequested,
		RemoteData::Loading { request },
		RemoteData::Ready(Versioned { revision: 1, value: vec![1] }),
		RemoteData::Empty,
		RemoteData::Stale {
			value:  Versioned { revision: 1, value: vec![1] },
			reason: StaleReason::Disconnected,
		},
		RemoteData::Error { message: "retry".to_owned(), retryable: true, stale: None },
		RemoteData::Error {
			message:   "retry".to_owned(),
			retryable: true,
			stale:     Some(Versioned { revision: 1, value: vec![1] }),
		},
	];
	for state in &states {
		match surface(&connection, state) {
			SurfaceState::Loading { .. }
			| SurfaceState::Empty
			| SurfaceState::Ready { .. }
			| SurfaceState::Unavailable { .. }
			| SurfaceState::Fatal { .. } => {},
		}
	}
}

#[test]
fn stale_and_failed_refreshes_keep_readable_entries() {
	let connection = ConnectionState::Reconnecting {
		attempt:     2,
		retry_at_ms: 50,
		message:     "offline".to_owned(),
	};
	let stale = RemoteData::Stale {
		value:  Versioned { revision: 7, value: vec![1, 2] },
		reason: StaleReason::Reconnecting,
	};
	assert!(matches!(surface(&connection, &stale), SurfaceState::Ready { stale: Some(_), .. }));

	let failed = RemoteData::Error {
		message:   "refresh failed".to_owned(),
		retryable: true,
		stale:     ready(vec![1, 2]).readable().cloned(),
	};
	assert!(matches!(surface(&connection, &failed), SurfaceState::Ready {
		error: Some(("refresh failed", true)),
		..
	}));
}

#[test]
fn syncing_reports_chunk_progress() {
	let connection = ConnectionState::Syncing { received: 12, expected: Some(20) };
	let data: RemoteData<Versioned<Vec<u8>>> =
		RemoteData::Loading { request: RequestId::new(1).expect("nonzero request") };
	assert_eq!(surface(&connection, &data), SurfaceState::Loading {
		received: Some(12),
		expected: Some(20),
	});
}

#[test]
fn reader_navigation_breaks_follow_and_counts_only_later_appends() {
	let mut follow = FollowState::default();
	follow.apply(FollowEvent::Appended(2));
	assert_eq!(follow, FollowState { following: true, unseen: 0 });
	follow.apply(FollowEvent::UserMovedAway);
	follow.apply(FollowEvent::Appended(3));
	follow.apply(FollowEvent::Appended(2));
	assert_eq!(follow, FollowState { following: false, unseen: 5 });
	assert!(follow.show_jump());
}

#[test]
fn reaching_or_jumping_to_the_end_rearms_follow() {
	for event in [FollowEvent::ReachedEnd, FollowEvent::JumpToLatest] {
		let mut follow = FollowState { following: false, unseen: 7 };
		follow.apply(event);
		assert_eq!(follow, FollowState { following: true, unseen: 0 });
	}
}

#[test]
fn fatal_connection_precedes_stale_content() {
	let connection = ConnectionState::Fatal { message: "protocol mismatch".to_owned() };
	let data = RemoteData::Stale {
		value:  Versioned { revision: 1, value: vec![1] },
		reason: StaleReason::Disconnected,
	};
	assert_eq!(surface(&connection, &data), SurfaceState::Fatal { message: "protocol mismatch" });
}

#[test]
fn row_transition_detects_prefix_and_prepend() {
	let initial = vec!["a", "b", "c"];
	let appended = vec!["a", "b", "c", "d", "e"];
	assert_eq!(row_transition(&initial, &appended), RowTransition::Prefix { appended: 2 });

	let prepended = vec!["x", "y", "a", "b", "c"];
	assert_eq!(row_transition(&initial, &prepended), RowTransition::Prepend { prepended: 2 });

	let replaced = vec!["x", "b", "z"];
	assert_eq!(row_transition(&initial, &replaced), RowTransition::Reset);
}

#[test]
fn loading_progress_formats_states() {
	assert_eq!(loading_progress(Some(3), Some(10)), "3 of 10 entries received");
	assert_eq!(loading_progress(Some(5), None), "5 entries received");
	assert_eq!(loading_progress(None, None), "Waiting for the transcript snapshot");
}
