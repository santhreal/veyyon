//! Where the archived and deferred blocks list their threads, and the time a
//! placement records.
//!
//! WHY: `Archived` lists the thread put away last first and `Deferred` the
//! thread due back soonest first, each by the time its move recorded. A move
//! that records no time, or one time for every thread, ties the rows, and the
//! block falls back to the thread id: the thread archived a second ago lists
//! under one archived last week. A block a thread enters by key and cannot
//! leave, or leaves without recording when it came back, strands it or lists
//! it among its project's threads by a stale anchor. The sweep walks
//! `QueuePartition::ALL` through the placement keys at the sidebar's own
//! clock, so a new partition fails here until its key is recorded.
//!
//! Gap: the sidebar's defer names no return time, so a dated deferral comes
//! only from a store the window reopens; how one is dated is not driven. The
//! lines are asserted, not the drawn rows.

use std::sync::atomic::{AtomicU64, Ordering};

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::{ToggleArchiveSelected, ToggleDeferSelected, TogglePinSelected},
	sidebar::listing::{Block, Item},
};
use veyyon_desktop_model::{HostAction, QueuePartition, Store, reduce};

use super::{items, leaf, listing, seeded, sent, sid, sidebar, sidebar_over, summary};

/// The time the sweep's sidebar reads, in milliseconds.
static CLOCK_MS: AtomicU64 = AtomicU64::new(0);

fn clock() -> u64 {
	CLOCK_MS.load(Ordering::SeqCst)
}

/// What the moves of `id` recorded: its partition, when it was archived,
/// when it is due back, and when it last came back among its project's
/// threads.
fn stamps(
	state: &Entity<AppState>,
	cx: &VisualTestContext,
	id: &str,
) -> (QueuePartition, Option<u64>, Option<u64>, u64) {
	state.read_with(cx, |state, _| {
		let session = state
			.store()
			.sessions
			.get(&sid(id))
			.expect("the session is listed");
		(session.partition, session.parked_at_ms, session.defer_until_ms, session.last_recall_at_ms)
	})
}

/// Presses the key that places the selected thread in `partition`, or takes
/// it back out; `false` for `Live`, where every other block returns a thread
/// and which no key places one in.
fn press(cx: &mut VisualTestContext, partition: QueuePartition) -> bool {
	match partition {
		QueuePartition::Pinned => cx.dispatch_action(TogglePinSelected),
		QueuePartition::Deferred => cx.dispatch_action(ToggleDeferSelected),
		QueuePartition::Parked => cx.dispatch_action(ToggleArchiveSelected),
		QueuePartition::Live => return false,
	}
	cx.run_until_parked();
	true
}

#[gpui::test]
fn the_archive_lists_the_thread_archived_last_first_each_at_the_time_it_was_archived(
	app: &mut TestAppContext,
) {
	// Listed p0, p1, p2 under `/w/alpha`.
	let (state, view, cx) = sidebar(app, vec![listing(vec![
		summary("p0", "/w/alpha", 300, None),
		summary("p1", "/w/alpha", 200, None),
		summary("p2", "/w/alpha", 100, None),
	])]);
	// Archived in an order that is neither the listing's nor the ids'.
	let archived = [("p0", 1_000), ("p2", 2_000), ("p1", 3_000)];
	for (id, at) in archived {
		state.update(cx, |state, cx| state.place_session(&sid(id), QueuePartition::Parked, at, cx));
	}
	cx.run_until_parked();

	for (id, at) in archived {
		assert_eq!(stamps(&state, cx, id).1, Some(at), "{id} records the time it was archived");
	}
	assert_eq!(
		items(&view, cx),
		vec![
			Item::Project(0),
			Item::Block { block: Block::Archived, count: 3 },
			leaf(0, 1),
			leaf(0, 2),
			leaf(0, 0),
		],
		"p1, archived last, lists first and p0, archived first, last"
	);
}

#[gpui::test]
fn deferred_threads_list_the_soonest_return_first_and_one_deferred_by_key_last(
	app: &mut TestAppContext,
) {
	// Listed undated, late, soon under `/w/alpha`.
	let threads = || {
		listing(vec![
			summary("undated", "/w/alpha", 300, None),
			summary("late", "/w/alpha", 200, None),
			summary("soon", "/w/alpha", 100, None),
		])
	};
	// The window reopens a store holding two dated deferrals, and the host
	// lists the threads again.
	let mut store = Store::new();
	let _ = reduce(&mut store, threads());
	store.sessions.defer(&sid("late"), Some(9_000));
	store.sessions.defer(&sid("soon"), Some(4_000));
	let (state, view, cx) = sidebar_over(app, store, vec![threads()]);
	state.update(cx, |state, cx| {
		state.place_session(&sid("undated"), QueuePartition::Deferred, 1_000, cx);
	});
	cx.run_until_parked();

	assert_eq!(
		stamps(&state, cx, "undated").2,
		None,
		"a deferral by key names no return time and invents none"
	);
	assert_eq!(stamps(&state, cx, "late").2, Some(9_000), "a re-listing keeps a return time");
	assert_eq!(
		items(&view, cx),
		vec![
			Item::Project(0),
			Item::Block { block: Block::Deferred, count: 3 },
			leaf(0, 2),
			leaf(0, 1),
			leaf(0, 0),
		],
		"soon, then late, then the thread with no return time"
	);
}

#[gpui::test]
fn every_block_a_key_places_a_thread_in_takes_it_back_out_at_the_time_of_the_press(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, seeded());
	view.update(cx, |view, cx| view.set_clock(clock, cx));
	cx.run_until_parked();

	// `a` is selected, and came back among its project's threads when it
	// was last written, at 100.
	let mut placed = Vec::new();
	let mut returned = 100;
	let mut at = 10_000;
	for partition in QueuePartition::ALL {
		at += 1_000;
		CLOCK_MS.store(at, Ordering::SeqCst);
		if !press(cx, partition) {
			continue;
		}
		placed.push(partition);
		let archived = (partition == QueuePartition::Parked).then_some(at);
		assert_eq!(
			stamps(&state, cx, "a"),
			(partition, archived, None, returned),
			"the key places `a` in {partition:?}, and only an archive records its time"
		);

		at += 1_000;
		CLOCK_MS.store(at, Ordering::SeqCst);
		assert!(press(cx, partition));
		assert_eq!(
			stamps(&state, cx, "a"),
			(QueuePartition::Live, None, None, at),
			"a second press takes `a` out of {partition:?} and records when it came back"
		);
		returned = at;
	}
	assert_eq!(
		placed,
		[QueuePartition::Pinned, QueuePartition::Deferred, QueuePartition::Parked],
		"a key places a thread in exactly these blocks; a new one needs its key or a recorded \
		 reason for having none"
	);
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "a placement stays in the window");
}
