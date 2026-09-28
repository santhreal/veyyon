//! The window cuts its list into the turns its branch reads, however the
//! entries of that branch arrived.
//!
//! WHY: the window keeps its turn index splice by splice instead of reading
//! the branch again. An entry appended at the end of the order opened a turn
//! of its own whatever its role, so a reply appended after its prompt, or a
//! note appended after a reply, cut one turn in two. The call a turn waited
//! on then sat in a turn that was no longer the last, and the window folded
//! it under `Worked for` while the dock asked whether to run it. The suites
//! that read turns built the index from scratch, and the one that drew a
//! waiting turn sent it whole, so none saw it. The sweep delivers a branch
//! holding an entry of every role by each host event that carries entries,
//! and after each event compares the index the window kept with the one its
//! branch reads from scratch; the match over `HostEventKind` names every
//! kind, so a kind added to the model does not compile here until it states
//! how it delivers entries. An entry of every role appended must name the
//! turn before it, from that turn's start, as the range to measure again: an
//! entry that is not a prompt joins that turn, and a prompt closes it, and
//! either changes what the turn's earlier items draw. A turn waiting
//! on each kind of decision is then sent in the order a live turn sends it,
//! one entry at a time with the record of the decision after the call, and
//! must stay drawn running until the decision leaves.
//!
//! Gap: the index is compared, not the drawing of every item; the drawing is
//! read for the waiting turn only. The list draws every visible item each
//! frame, so a height left stale by a short range shows only on an item out
//! of view; the range is asserted rather than the height.

use std::ops::Range;

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::transcript::turn::TurnIndex;
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, HostEventKind, MessageRole, PendingDecisions,
	StreamingMessageState, TranscriptEntry,
};

use super::{
	Thread, chain, entry,
	items::{appended, drawn_by, restated},
	opened, sid, snapshot, text, thread,
	waiting::{one_in_each_queue, waiting_on},
};

/// A call to `read` with id `id`.
fn call(id: &str) -> ContentBlock {
	ContentBlock::ToolCall {
		id:           id.to_owned(),
		name:         "read".to_owned(),
		arguments:    serde_json::json!({ "path": "src/lib.rs" }),
		presentation: None,
	}
}

/// A branch opened by a note, then for every role a prompt, a reply that
/// makes a call, an entry of that role and a closing reply. The entry of
/// each role lands in the turn before it unless it is a prompt; a result
/// answers the call before it.
fn every_role() -> Vec<TranscriptEntry> {
	let mut rows = vec![("note".to_owned(), MessageRole::Custom, Vec::new())];
	for role in MessageRole::iter() {
		let name = format!("{role:?}");
		let body = if role == MessageRole::ToolResult {
			ContentBlock::ToolResult {
				tool:         name.clone(),
				content:      serde_json::json!("12 lines"),
				is_error:     false,
				presentation: None,
			}
		} else {
			text(&format!("{name} entry"))
		};
		rows.extend([
			(format!("{name}-prompt"), MessageRole::User, vec![text(&format!("{name} prompt"))]),
			(format!("{name}-call"), MessageRole::Assistant, vec![call(&name)]),
			(name.clone(), role, vec![body]),
			(format!("{name}-reply"), MessageRole::Assistant, vec![text("done")]),
		]);
	}
	chain(
		rows
			.iter()
			.map(|(id, role, content)| (id.as_str(), *role, content.clone()))
			.collect(),
	)
}

/// The orders in which events of `kind` deliver `branch` to a thread opened
/// on an empty transcript, each event applied on its own, or `None` for a
/// kind that carries no entry.
fn deliveries(
	kind: HostEventKind,
	branch: &[TranscriptEntry],
) -> Option<Vec<(&'static str, Vec<HostEvent>)>> {
	let one_by_one = || branch.iter().map(|entry| appended(vec![entry.clone()]));
	match kind {
		HostEventKind::Snapshot => Some(vec![("sent whole", vec![snapshot(2, branch.to_vec())])]),
		HostEventKind::TranscriptAppended => Some(vec![
			("appended one by one", one_by_one().collect()),
			("appended at once", vec![appended(branch.to_vec())]),
		]),
		HostEventKind::TranscriptUpdated => Some(vec![(
			"appended one by one, then each restated with one more block",
			one_by_one()
				.chain(branch.iter().map(|entry| {
					let mut grown = entry.clone();
					grown.revision += 1;
					grown.content.push(text("restated"));
					restated(grown)
				}))
				.collect(),
		)]),
		// A reply streams into the tail, and the entry it ends as is appended
		// once the tail lets it go.
		HostEventKind::StreamingChanged => Some(vec![(
			"each reply streamed, then appended",
			branch
				.iter()
				.flat_map(|entry| {
					let streamed = (entry.role == MessageRole::Assistant).then(|| {
						[
							HostEvent::StreamingChanged(Some(StreamingMessageState {
								entry:        EntryId::from("stream"),
								tool:         None,
								accumulating: entry.clone(),
								revision:     1,
							})),
							HostEvent::StreamingChanged(None),
						]
					});
					streamed
						.into_iter()
						.flatten()
						.chain([appended(vec![entry.clone()])])
				})
				.collect(),
		)]),
		// Text the streaming reply grew by is drawn by the tail and held by no
		// entry; the rest carry no transcript at all.
		HostEventKind::StreamingAppended
		| HostEventKind::ConnectionChanged
		| HostEventKind::RequestSucceeded
		| HostEventKind::RequestFailed
		| HostEventKind::FatalProtocolError => None,
	}
}

/// The display range of each turn `index` cuts `count` items into.
fn ranges(index: &TurnIndex, count: usize) -> Vec<Range<usize>> {
	let mut ranges: Vec<Range<usize>> = (0..count)
		.filter_map(|ix| index.turn_at(ix).map(|turn| turn.range.clone()))
		.collect();
	ranges.dedup();
	ranges
}

/// The turns the window kept and the turns its branch reads from scratch,
/// when the two differ.
fn kept_apart(thread: &mut Thread<'_>) -> Option<String> {
	let (state, transcript) = (thread.state.clone(), thread.transcript.clone());
	thread.cx.update(|_, cx| {
		let state = state.read(cx);
		let mut read = TurnIndex::default();
		read.rebuild(state, &sid());
		let kept = transcript.read(cx).turns();
		let count = state.entry_count(&sid());
		(kept != &read).then(|| {
			format!("kept {:?}, the branch reads {:?}", ranges(kept, count), ranges(&read, count))
		})
	})
}

#[gpui::test]
fn the_turns_the_window_keeps_are_the_turns_its_branch_reads_however_its_entries_arrive(
	cx: &mut TestAppContext,
) {
	let branch = every_role();
	let mut broke = Vec::new();
	for kind in HostEventKind::iter() {
		let Some(orders) = deliveries(kind, &branch) else {
			continue;
		};
		'orders: for (order, events) in orders {
			let mut thread = thread(cx, opened(Vec::new()));
			for (step, event) in events.into_iter().enumerate() {
				thread.apply(vec![event]);
				if let Some(apart) = kept_apart(&mut thread) {
					broke.push(format!("{order}, after event {step}: {apart}"));
					continue 'orders;
				}
			}
			let listed = thread.ids().len();
			if listed != branch.len() {
				broke.push(format!("{order} listed {listed} of {} entries", branch.len()));
			}
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"the window cut its list into turns its branch does not read"
	);
}

#[gpui::test]
fn an_entry_appended_names_the_turn_before_it_from_that_turns_start_for_every_role(
	cx: &mut TestAppContext,
) {
	let mut broke = Vec::new();
	for role in MessageRole::iter() {
		let mut thread = thread(
			cx,
			opened(chain(vec![
				("u1", MessageRole::User, vec![text("read the parser")]),
				("a1", MessageRole::Assistant, vec![call("c")]),
			])),
		);
		let mut index = TurnIndex::default();
		thread
			.state
			.read_with(&*thread.cx, |state, _| index.rebuild(state, &sid()));
		let before = index.turn_at(1).map(|turn| turn.range.start..3);
		thread.apply(vec![appended(vec![entry("x", Some("a1"), role, vec![text("x")])])]);
		let touched = thread
			.state
			.read_with(&*thread.cx, |state, _| index.splice(state, &sid(), &(2..2)));
		if Some(&touched) != before.as_ref() {
			broke.push(format!("{role:?} touched {touched:?}, not {before:?}"));
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"an append does not name the turn before it, so that turn's items keep heights measured \
		 before the entry joined it or closed it"
	);
}

/// Whether the reply's item drew the fold row, and whether it drew its call
/// row.
fn folded_and_call(thread: &mut Thread<'_>) -> (bool, bool) {
	let words = drawn_by(thread, "a1");
	(
		words.iter().any(|word| word.starts_with("▸ Worked for")),
		words.iter().any(|word| word == "Read"),
	)
}

#[gpui::test]
fn a_call_waiting_on_a_decision_stays_drawn_running_when_its_turn_arrives_entry_by_entry(
	cx: &mut TestAppContext,
) {
	let mut broke = Vec::new();
	for (queue, pending) in one_in_each_queue() {
		let mut thread = thread(cx, opened(Vec::new()));
		let live = chain(vec![
			("model", MessageRole::Custom, Vec::new()),
			("u1", MessageRole::User, vec![text("read the parser")]),
			("title", MessageRole::Custom, Vec::new()),
			("a1", MessageRole::Assistant, vec![call("c")]),
		]);
		for entry in live {
			thread.apply(vec![appended(vec![entry])]);
		}
		thread.apply(vec![waiting_on(pending)]);
		thread.apply(vec![appended(vec![entry(
			"asked",
			Some("a1"),
			MessageRole::Custom,
			Vec::new(),
		)])]);
		let waiting = folded_and_call(&mut thread);
		if waiting != (false, true) {
			broke.push(format!("waiting on a {queue}: folded and call {waiting:?}"));
		}
		thread.apply(vec![waiting_on(PendingDecisions::new())]);
		let withdrawn = folded_and_call(&mut thread);
		if withdrawn != (true, false) {
			broke.push(format!("with the {queue} withdrawn: folded and call {withdrawn:?}"));
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"a call waiting on a decision in a turn that arrived entry by entry is drawn finished"
	);
}
