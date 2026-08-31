//! Snapshot assimilation, revision gaps, and stale replica preservation.

use super::helpers::*;
use crate::{
	host::{HostEvent, SnapshotSection},
	model::*,
	store::Store,
};

#[test]
fn ordered_events_are_idempotent_and_revision_gaps_stale_the_replica() {
	let mut store = Store::detached();
	store.apply(HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 4,
		value:    vec![unknown_entry("a", 4)],
	})));
	let first = HostEvent::TranscriptAppended { revision: 5, entries: vec![unknown_entry("b", 5)] };
	assert!(store.apply(first.clone()).replica);
	assert!(store.apply(first).ignored_stale_event);
	assert_eq!(
		store
			.replica
			.transcript
			.readable()
			.map(|value| value.value.len()),
		Some(2)
	);
	let gap = store
		.apply(HostEvent::TranscriptAppended { revision: 7, entries: vec![unknown_entry("c", 7)] });
	assert!(gap.ignored_stale_event);
	assert!(matches!(store.replica.transcript, RemoteData::Stale {
		reason: StaleReason::RevisionGap { expected: 6, received: 7 },
		..
	}));
}

#[test]
fn unknown_content_and_tool_payloads_survive_snapshots() {
	let mut store = Store::detached();
	let entry = unknown_entry("unknown", 1);
	store.apply(HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 1,
		value:    vec![entry.clone()],
	})));
	assert_eq!(
		store
			.replica
			.transcript
			.readable()
			.map(|value| &value.value[0]),
		Some(&entry)
	);
	assert_eq!(entry.raw, Value::Opaque {
		media_type: "application/json".to_owned(),
		bytes:      vec![0, 255, 3],
	});
}

#[test]
fn stale_snapshots_are_preserved_when_older_revisions_arrive() {
	let mut store = Store::detached();
	let entry1 = unknown_entry("e1", 5);
	let entry2 = unknown_entry("e2", 3);

	store.apply(HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 5,
		value:    vec![entry1.clone()],
	})));
	assert_eq!(store.replica.transcript.readable().map(|v| v.revision), Some(5));

	let older = store.apply(HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 3,
		value:    vec![entry2],
	})));
	assert!(!older.replica);
	assert_eq!(store.replica.transcript.readable().map(|v| v.revision), Some(5));
	assert_eq!(store.replica.transcript.readable().map(|v| &v.value[0].id), Some(&entry1.id));
}
