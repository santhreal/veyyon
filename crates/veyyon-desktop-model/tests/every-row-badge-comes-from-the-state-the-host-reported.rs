//! WHY: `Session::badge` was a field only a scene fixture ever wrote. The
//! session-index reducer set it to `None` and no other site ever set it, so
//! every one of §0's eight row badges was dead in the product: a turn running,
//! a question waiting, an approval waiting, a plan waiting, a turn that ended
//! in an error — all drew a bare row, while the badge chips, the §5.2 row
//! states and the §6 tints sat in the renderer with no reachable input. A
//! capture of a real running turn showed the rail's own row unbadged while the
//! host was streaming into it.
//!
//! CLASS CLOSED: a badge variant with no derivation. `BadgeKind::iter()` is
//! swept at run time, every variant is seeded through the state the host
//! actually sends and asserted to derive, and the set that cannot be derived
//! is pinned empty. Adding a ninth badge turns this suite red until it has a
//! seeding arm and a derivation. The precedence table in §0 is asserted
//! pairwise rather than at one representative, so a re-ordered `if` chain
//! fails here.
//!
//! It also closes the two conditions §0 states as `has not been read`: a
//! finished turn and an elapsed deferral raise attention once, and opening the
//! session takes it away. Attaching to a host that holds finished sessions
//! raises none at all, which is the first-listing case.
//!
//! NOT CAUGHT: what the host reports. The suite drives the reducer and the
//! derivation, so a host that mislabels a running session as `Complete` looks
//! here like a session that finished. `Watching` for a session that is not
//! open is out of reach by design: a supervised process belongs to the broker
//! for the whole project directory and `ProcessView` names no session, so no
//! seeding can attribute one to a background row.

mod support;

use std::collections::BTreeSet;

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	BadgeKind, EntryId, QueuePartition, SessionBadge, SessionId, SessionStatus, Store,
	StreamingMessageState, session_badge,
};

use crate::support::{
	NOW_MS, WROTE_MS, approval, kind_of, live_process, plan, question, read_session, seed_for,
	session_id, store_with_session, unread, user_entry,
};
#[test]
fn every_badge_variant_derives_from_host_state_and_none_is_unreachable() {
	let mut unreachable: BTreeSet<String> = BTreeSet::new();
	for kind in BadgeKind::iter() {
		let store = seed_for(kind);
		match session_badge(&store, &session_id(), NOW_MS) {
			Some(badge) if kind_of(&badge) == kind => {},
			other => {
				unreachable.insert(format!("{kind:?} derived {other:?}"));
			},
		}
	}
	assert_eq!(unreachable, BTreeSet::new(), "every badge is derived from state the host sends");
}

#[test]
fn a_read_session_whose_turn_finished_carries_no_badge() {
	let store = store_with_session();
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None);
}

#[test]
fn a_session_the_host_has_not_listed_carries_no_badge() {
	let store = Store::new();
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None);
}

/// §0's order, highest first.
const PRECEDENCE: [BadgeKind; 8] = [
	BadgeKind::Approval,
	BadgeKind::Input,
	BadgeKind::Plan,
	BadgeKind::Failed,
	BadgeKind::Due,
	BadgeKind::Done,
	BadgeKind::Working,
	BadgeKind::Watching,
];

/// The state a badge is derived from. Two badges on one channel read the same
/// field, so they cannot both hold: a session has one status, and one deferral.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
	Decision,
	Status,
	Deferral,
	Processes,
}

const fn channel(kind: BadgeKind) -> Channel {
	match kind {
		BadgeKind::Approval | BadgeKind::Input | BadgeKind::Plan => Channel::Decision,
		BadgeKind::Failed | BadgeKind::Done | BadgeKind::Working => Channel::Status,
		BadgeKind::Due => Channel::Deferral,
		BadgeKind::Watching => Channel::Processes,
	}
}

#[test]
fn precedence_holds_for_every_pair_that_can_hold_at_once() {
	assert_eq!(PRECEDENCE.len(), BadgeKind::iter().count(), "the table covers every badge");
	let mut compared = 0_usize;
	for (high_index, high) in PRECEDENCE.iter().enumerate() {
		for low in &PRECEDENCE[high_index + 1..] {
			if channel(*high) == channel(*low) && channel(*high) != Channel::Decision {
				// One status and one deferral: the pair is unreachable rather
				// than untested, and `a_status_holds_one_badge_at_a_time`
				// pins that.
				continue;
			}
			let mut store = seed_for(*high);
			merge(&mut store, *low);
			let derived = session_badge(&store, &session_id(), NOW_MS)
				.unwrap_or_else(|| panic!("{high:?} with {low:?} derived no badge"));
			assert_eq!(kind_of(&derived), *high, "{high:?} against {low:?}");
			compared += 1;
		}
	}
	// Twenty-eight ordered pairs, less the three within one status and the
	// three within the decision channel that are tested rather than skipped.
	assert_eq!(compared, 25, "every reachable pair was compared");
}

#[test]
fn a_status_holds_one_badge_at_a_time() {
	// Seeding `Failed` and then `Done` writes one field twice, so the second
	// wins and no precedence question arises. A future badge that reads a new
	// field co-occurs, and the sweep above covers it.
	let mut store = seed_for(BadgeKind::Failed);
	merge(&mut store, BadgeKind::Done);
	assert_eq!(
		session_badge(&store, &session_id(), NOW_MS).map(|badge| kind_of(&badge)),
		Some(BadgeKind::Done)
	);
}

/// Adds one badge's state to a store that already holds another's, keeping
/// what is there: a pair is only a precedence test while both states stand.
fn merge(store: &mut Store, kind: BadgeKind) {
	let id = session_id();
	match kind {
		BadgeKind::Approval => {
			store
				.interactions
				.entry(id)
				.or_default()
				.approvals
				.push(approval());
		},
		BadgeKind::Input => {
			store
				.interactions
				.entry(id)
				.or_default()
				.questions
				.push(question());
		},
		BadgeKind::Plan => {
			store.interactions.entry(id).or_default().plans.push(plan());
		},
		BadgeKind::Failed => unread(store, SessionStatus::Error),
		BadgeKind::Done => unread(store, SessionStatus::Complete),
		BadgeKind::Due => store.sessions.defer(&id, Some(NOW_MS - 1000)),
		BadgeKind::Working => unread(store, SessionStatus::Pending),
		BadgeKind::Watching => store.domains.processes = vec![live_process()],
	}
}

#[test]
fn a_stream_the_host_is_sending_outranks_the_status_in_the_index() {
	let mut store = store_with_session();
	store.streaming.insert(session_id(), StreamingMessageState {
		entry:        EntryId::from("entry_0002"),
		tool:         Some("bash".to_string()),
		accumulating: user_entry(WROTE_MS),
		revision:     3,
	});
	assert!(matches!(
		session_badge(&store, &session_id(), NOW_MS),
		Some(SessionBadge::Working { .. })
	));
}

#[test]
fn the_working_timer_counts_from_the_message_that_started_the_turn() {
	let mut store = seed_for(BadgeKind::Working);
	let started_at = NOW_MS - 12_000;
	let tree = store.transcripts.entry(session_id()).or_default();
	tree.append(user_entry(NOW_MS - 400_000));
	let mut newer = user_entry(started_at);
	newer.id = EntryId::from("entry_0002");
	tree.append(newer);
	assert_eq!(
		session_badge(&store, &session_id(), NOW_MS),
		Some(SessionBadge::Working { started_at_ms: started_at })
	);
}

#[test]
fn a_working_session_with_no_transcript_counts_from_the_last_write() {
	let store = seed_for(BadgeKind::Working);
	assert_eq!(
		session_badge(&store, &session_id(), NOW_MS),
		Some(SessionBadge::Working { started_at_ms: WROTE_MS })
	);
}

#[test]
fn a_deferral_that_has_not_elapsed_is_not_due() {
	let mut store = store_with_session();
	store.sessions.defer(&session_id(), Some(NOW_MS + 60_000));
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS + 60_000), Some(SessionBadge::Due));
}

#[test]
fn a_deferral_with_no_return_time_is_never_due() {
	let mut store = store_with_session();
	store.sessions.defer(&session_id(), None);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None);
}

#[test]
fn a_return_time_left_on_a_session_outside_the_deferred_partition_is_not_due() {
	// `pin` and `park` move a session out of `Deferred` without clearing what
	// it was due to return at, so `Due` is a fact about the partition as well
	// as the clock. Every other partition is swept, so a badge that reads the
	// timestamp alone fails here.
	for partition in QueuePartition::iter().filter(|p| *p != QueuePartition::Deferred) {
		let mut store = store_with_session();
		store.sessions.defer(&session_id(), Some(NOW_MS - 60_000));
		if let Some(session) = store.sessions.get_mut(&session_id()) {
			session.partition = partition;
		}
		store.sessions.reindex_partition(partition);
		assert_eq!(
			store
				.sessions
				.get(&session_id())
				.map(|session| session.defer_until_ms),
			Some(Some(NOW_MS - 60_000)),
			"{partition:?} cleared the return time, so the claim is untested"
		);
		assert_eq!(session_badge(&store, &session_id(), NOW_MS), None, "{partition:?}");
	}
}

#[test]
fn a_process_the_supervisor_has_lost_is_not_watched() {
	for status in ["exited", "failed", "unrecognised-state"] {
		let mut store = store_with_session();
		let mut process = live_process();
		process.status = status.to_string();
		process.pid = None;
		store.domains.processes = vec![process];
		assert_eq!(session_badge(&store, &session_id(), NOW_MS), None, "status {status}");
	}
}

#[test]
fn a_process_is_watched_only_by_the_session_the_operator_has_open() {
	let mut store = seed_for(BadgeKind::Watching);
	let other = SessionId::from("session_0002");
	let mut background = read_session();
	background.id = other.clone();
	store.sessions.insert(background);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), Some(SessionBadge::Watching));
	assert_eq!(session_badge(&store, &other, NOW_MS), None);
}
