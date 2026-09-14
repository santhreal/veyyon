//! WHY: `Intent::ParkSession` and `Intent::DeferSession` recorded the epoch as
//! the moment they happened. `Parked` orders by when a session was put away and
//! `Deferred` by when it returns, so every row shared the key `0` and both
//! sections fell back to the row id: the session parked a second ago sorted
//! under one parked last week. `Intent::UnpinSession` did not exist at all, so
//! `Pinned` was the one partition with no way back to `Live`.
//!
//! CLASS CLOSED: a partition a session can enter and not leave, and a partition
//! move that records no time. The sweep walks `QueuePartition::ALL`, so a sixth
//! partition fails here until someone states the pair of intents that moves a
//! session in and out of it, or records that it has none.
//!
//! GAPS: it says nothing about how the rail draws the sections it orders --
//! that is `the-parked-section-pages-in-older-sessions-from-its-own-row.rs` --
//! and nothing about which gesture dispatches the intent, which is the surface
//! crate's chord and menu suites.

mod support;

use std::{
	collections::HashMap,
	time::{SystemTime, UNIX_EPOCH},
};

use support::session;
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{QueuePartition, SessionId, Store};
use veyyon_desktop_surface::{Intent, ShellState};

fn wall_clock_ms() -> u64 {
	u64::try_from(
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("the clock is after the epoch")
			.as_millis(),
	)
	.expect("milliseconds fit in u64")
}

/// The store, the row index and the projected state, kept in step the way the
/// window keeps them: an intent is applied and the sections are re-projected.
struct Rail {
	store: Store,
	index: SessionIndex,
	state: ShellState,
}

impl Rail {
	fn with_sessions(ids: &[&str]) -> Self {
		let mut store = Store::new();
		for id in ids {
			store.sessions.insert(session(id, QueuePartition::Live));
		}
		store.persisted.shell.active_session = Some(SessionId::from(ids[0]));
		let mut rail = Self { store, index: SessionIndex::new(), state: ShellState::default() };
		rail.reproject();
		rail
	}

	fn reproject(&mut self) {
		project(&self.store, &mut self.index, &HashMap::new(), wall_clock_ms(), &mut self.state);
	}

	fn row(&mut self, id: &str) -> u64 {
		self.index.row_of(&SessionId::from(id))
	}

	fn apply(&mut self, intent: &Intent) {
		let actions = actions_for(intent, &self.index, &mut self.store);
		assert!(
			actions.is_empty(),
			"a partition move is the window's own state and asks the host for nothing: {actions:?}"
		);
		self.reproject();
	}

	fn partition_of(&self, id: &str) -> QueuePartition {
		self
			.store
			.sessions
			.get(&SessionId::from(id))
			.expect("the session is in the store")
			.partition
	}

	fn parked_at(&self, id: &str) -> Option<u64> {
		self
			.store
			.sessions
			.get(&SessionId::from(id))
			.expect("the session is in the store")
			.parked_at_ms
	}

	fn defer_until(&self, id: &str) -> Option<u64> {
		self
			.store
			.sessions
			.get(&SessionId::from(id))
			.expect("the session is in the store")
			.defer_until_ms
	}

	fn recalled_at(&self, id: &str) -> u64 {
		self
			.store
			.sessions
			.get(&SessionId::from(id))
			.expect("the session is in the store")
			.last_recall_at_ms
	}
}

/// The pair of intents that moves a session into a partition and back out to
/// `Live`, for the partitions an operator moves a session between.
const fn move_pair(partition: QueuePartition, row: u64) -> Option<(Intent, Intent)> {
	match partition {
		QueuePartition::Pinned => Some((Intent::PinSession(row), Intent::UnpinSession(row))),
		QueuePartition::Deferred => Some((Intent::DeferSession(row), Intent::RecallSession(row))),
		QueuePartition::Parked => Some((Intent::ParkSession(row), Intent::UnparkSession(row))),
		// `Live` is where both halves of every pair above land.
		QueuePartition::Live => None,
	}
}

#[test]
fn every_partition_an_operator_moves_into_moves_back_out_to_live() {
	let mut moved: Vec<QueuePartition> = Vec::new();
	for partition in QueuePartition::ALL {
		let mut rail = Rail::with_sessions(&["s"]);
		let row = rail.row("s");
		let Some((into, out)) = move_pair(partition, row) else {
			continue;
		};
		moved.push(partition);
		// Nothing arrives from the host to redraw the rail after a partition
		// move, so both halves of the pair have to be intents the window
		// re-projects for.
		for intent in [&into, &out] {
			assert!(
				intent.moves_partition(),
				"{intent:?} moves a session between partitions and must say so, or the rail keeps \
				 drawing the section it left"
			);
		}

		let before = wall_clock_ms();
		rail.apply(&into);
		let after = wall_clock_ms();
		assert_eq!(
			rail.partition_of("s"),
			partition,
			"{into:?} must move the session into {partition:?}"
		);

		rail.apply(&out);
		assert_eq!(
			rail.partition_of("s"),
			QueuePartition::Live,
			"{out:?} must return the session to Live"
		);
		let recalled = rail.recalled_at("s");
		assert!(
			(before..=wall_clock_ms()).contains(&recalled),
			"{out:?} re-anchors Live with the moment it happened: {recalled} outside \
			 {before}..={after}"
		);
	}

	assert_eq!(
		moved,
		vec![QueuePartition::Pinned, QueuePartition::Deferred, QueuePartition::Parked],
		"the operator moves a session between exactly these partitions; a new one needs its pair of \
		 intents or a recorded reason for having none"
	);
}

#[test]
fn parking_records_the_moment_and_orders_the_section_by_it() {
	let mut rail = Rail::with_sessions(&["older", "newer"]);
	let older = rail.row("older");
	let newer = rail.row("newer");

	let before = wall_clock_ms();
	rail.apply(&Intent::ParkSession(older));
	rail.apply(&Intent::ParkSession(newer));
	let after = wall_clock_ms();

	let older_at = rail.parked_at("older").expect("parking records its moment");
	let newer_at = rail.parked_at("newer").expect("parking records its moment");
	assert!(
		(before..=after).contains(&older_at) && (before..=after).contains(&newer_at),
		"a park is recorded at the time it happened: {older_at} and {newer_at} outside \
		 {before}..={after}"
	);
	assert!(
		older_at <= newer_at,
		"the second park cannot precede the first: {older_at} then {newer_at}"
	);
	assert_eq!(
		rail.store.sessions.parked,
		vec![SessionId::from("newer"), SessionId::from("older")],
		"Parked orders by when a session was put away, most recent first (§5.2)"
	);
}

#[test]
fn deferring_from_the_rail_names_no_return_time_and_sorts_after_a_dated_one() {
	let mut rail = Rail::with_sessions(&["undated", "dated"]);
	let undated = rail.row("undated");

	rail.apply(&Intent::DeferSession(undated));
	assert_eq!(
		rail.defer_until("undated"),
		None,
		"the rail's defer offers no return time and must invent none"
	);

	// A dated deferral is what the ordering is for, and it comes first however
	// far off it is.
	rail
		.store
		.sessions
		.defer(&SessionId::from("dated"), Some(u64::MAX - 1));
	rail.reproject();
	assert_eq!(
		rail.store.sessions.deferred,
		vec![SessionId::from("dated"), SessionId::from("undated")],
		"Deferred orders soonest return first, and a deferral with no return time is last (§5.2)"
	);
}
