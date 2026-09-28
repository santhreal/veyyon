//! Streaming and transcript changes: the typed event and the exact splice
//! each batch produces.

use veyyon_desktop_app::{AppState, StoreEvent};
use veyyon_desktop_model::{HostEvent, Store, TranscriptEntry};

use super::{delta, displayed_ids, entry, opened, sid};

/// A state showing session `s` with the two entries `s-0` and `s-1`.
fn showing_two() -> AppState {
	let mut state = AppState::new(Store::new());
	state.reduce_batch(opened("s", 1, 2));
	assert_eq!(displayed_ids(&state, "s"), ["s-0", "s-1"]);
	state
}

const fn appended(entries: Vec<TranscriptEntry>, revision: u64) -> HostEvent {
	HostEvent::TranscriptAppended { revision, entries }
}

fn spliced(range: std::ops::Range<usize>, count: usize) -> Vec<StoreEvent> {
	vec![StoreEvent::TranscriptSpliced { session: sid("s"), range, count }]
}

#[test]
fn a_streamed_turn_emits_only_streaming_changed() {
	let mut state = showing_two();
	let only_streaming = vec![StoreEvent::StreamingChanged { session: sid("s") }];
	for revision in 0..200 {
		assert_eq!(state.reduce_batch(vec![delta("s-tail", revision)]), only_streaming);
	}
	assert_eq!(state.reduce_batch(vec![HostEvent::StreamingChanged(None)]), only_streaming);

	let turn = (200..400).map(|revision| delta("s-tail", revision)).collect();
	assert_eq!(state.reduce_batch(turn), only_streaming);
	assert_eq!(state.entry_count(&sid("s")), 2, "a delta adds no transcript entry");
}

#[test]
fn appending_three_entries_splices_them_after_the_last() {
	let mut state = showing_two();
	let one_event = vec![appended(vec![entry("a", None, 2), entry("b", None, 2), entry("c", None, 2)], 2)];
	assert_eq!(state.reduce_batch(one_event), spliced(2..2, 3));
	assert_eq!(displayed_ids(&state, "s"), ["s-0", "s-1", "a", "b", "c"]);

	let three_events = ["d", "e", "f"]
		.into_iter()
		.map(|id| appended(vec![entry(id, None, 3)], 3))
		.collect();
	assert_eq!(state.reduce_batch(three_events), spliced(5..5, 3));
	assert_eq!(state.entry_count(&sid("s")), 8);
}

#[test]
fn an_update_splices_its_own_item_and_nothing_off_the_branch() {
	let mut state = showing_two();
	let update = |id: &str| HostEvent::TranscriptUpdated { revision: 2, entry: entry(id, None, 2) };
	assert_eq!(state.reduce_batch(vec![update("s-0")]), spliced(0..1, 1));

	// A branch from `s-0` cuts `s-1` off the displayed chain.
	let branch = appended(vec![entry("b", Some("s-0"), 3)], 3);
	assert_eq!(state.reduce_batch(vec![branch]), spliced(1..2, 1));
	assert_eq!(displayed_ids(&state, "s"), ["s-0", "b"]);
	assert_eq!(state.reduce_batch(vec![update("s-1")]), Vec::<StoreEvent>::new());
}

#[test]
fn an_update_and_an_append_in_one_batch_report_one_covering_splice() {
	let mut state = showing_two();
	let batch = vec![
		HostEvent::TranscriptUpdated { revision: 2, entry: entry("s-1", None, 2) },
		appended(vec![entry("a", None, 2)], 2),
	];
	assert_eq!(state.reduce_batch(batch), spliced(1..2, 2));
}

#[test]
fn more_than_thirty_two_entry_changes_in_a_batch_reset_the_transcript() {
	let mut state = showing_two();
	let entries = |from: usize, count: usize| -> Vec<TranscriptEntry> {
		(from..from + count)
			.map(|ix| entry(&format!("n-{ix}"), None, 2))
			.collect()
	};
	let one_per_event = |from: usize, count: usize| -> Vec<HostEvent> {
		entries(from, count)
			.into_iter()
			.map(|entry| appended(vec![entry], 2))
			.collect()
	};
	assert_eq!(state.reduce_batch(one_per_event(0, 32)), spliced(2..2, 32));
	let reset = vec![StoreEvent::TranscriptReset { session: sid("s") }];
	assert_eq!(state.reduce_batch(one_per_event(32, 33)), reset);
	assert_eq!(state.entry_count(&sid("s")), 2 + 32 + 33);

	assert_eq!(state.reduce_batch(vec![appended(entries(65, 40), 3)]), reset);
	assert_eq!(state.entry_count(&sid("s")), 2 + 32 + 33 + 40);
}
