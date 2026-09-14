//! WHY: a request the host refused was reduced into the store with its error
//! dropped on the floor, so a control the operator could not see failed in
//! silence. The queue this suite drives is what holds such a thing until it
//! is read, and every property a queue like that can get wrong -- announcing
//! the same failure once per retry, drawing the least important thing first,
//! keeping a card forever, growing without a bound -- is a defect this suite
//! is here to catch.
//!
//! CLASS CLOSED: dedupe by key, order by priority and age, expiry by
//! priority, and the bound with its eviction rule. The priority and source
//! vocabularies are swept from `strum::IntoEnumIterator` rather than listed,
//! so a new member turns this red until a decision is recorded for it: a
//! priority with no stated lifetime and a source with no wire string are both
//! failures here.
//!
//! NOT CAUGHT: what the window draws from the queue, which is the surface
//! suite, and what raises an announcement in the first place, which is the
//! reducer suite. A queue that holds the right announcement and a stack that
//! draws the wrong one are separate defects and this file sees only the first.

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
use veyyon_desktop_model::{
	NOTIFICATION_CAPACITY, Notification, NotificationPriority, NotificationQueue,
	NotificationSource, Raised,
};

const T0: u64 = 1_000_000;

fn announcement(key: &str, priority: NotificationPriority, at_ms: u64) -> Notification {
	Notification {
		key: key.to_string(),
		source: NotificationSource::RequestFailed,
		priority,
		title: format!("{key} failed"),
		detail: None,
		raised_at_ms: at_ms,
	}
}

fn keys(queue: &NotificationQueue) -> Vec<&str> {
	queue
		.raised()
		.iter()
		.map(|held| held.key.as_str())
		.collect()
}

#[test]
fn a_second_announcement_under_one_key_restates_the_first_rather_than_stacking() {
	let mut queue = NotificationQueue::new();
	assert_eq!(queue.raise(announcement("retry", NotificationPriority::Low, T0)), Raised::Added);

	let mut again = announcement("retry", NotificationPriority::Normal, T0 + 500);
	again.title = "retry failed again".to_string();
	again.detail = Some("connection reset".to_string());
	assert_eq!(queue.raise(again), Raised::Merged, "one key is one announcement");

	assert_eq!(queue.len(), 1);
	let held = &queue.raised()[0];
	assert_eq!(held.title, "retry failed again", "the card states the newest failure");
	assert_eq!(held.detail.as_deref(), Some("connection reset"));
	assert_eq!(
		held.priority,
		NotificationPriority::Normal,
		"a merge keeps the more interrupting of the two priorities"
	);
	assert_eq!(
		held.raised_at_ms,
		T0 + 500,
		"the clock restarts from the newest statement, so a failing loop keeps its card up"
	);
	assert!(queue.holds("retry"));
	assert!(!queue.holds("other"));
}

#[test]
fn a_merge_never_lowers_the_priority_a_card_was_raised_at() {
	let mut queue = NotificationQueue::new();
	queue.raise(announcement("gate", NotificationPriority::Urgent, T0));
	queue.raise(announcement("gate", NotificationPriority::Low, T0 + 10));
	assert_eq!(
		queue.raised()[0].priority,
		NotificationPriority::Urgent,
		"a routine restatement of an urgent thing does not make it routine"
	);
	assert_eq!(
		queue.raised()[0].expires_at_ms(),
		None,
		"and it keeps the lifetime that priority states"
	);
}

#[test]
fn the_stack_reads_most_urgent_first_then_oldest_then_by_key() {
	let mut queue = NotificationQueue::new();
	queue.raise(announcement("b-low", NotificationPriority::Low, T0));
	queue.raise(announcement("a-urgent-new", NotificationPriority::Urgent, T0 + 100));
	queue.raise(announcement("z-urgent-old", NotificationPriority::Urgent, T0));
	queue.raise(announcement("a-normal", NotificationPriority::Normal, T0 + 50));

	assert_eq!(keys(&queue), ["z-urgent-old", "a-urgent-new", "a-normal", "b-low"]);
}

#[test]
fn two_announcements_raised_in_one_millisecond_draw_in_one_order() {
	let mut first = NotificationQueue::new();
	first.raise(announcement("alpha", NotificationPriority::Normal, T0));
	first.raise(announcement("beta", NotificationPriority::Normal, T0));
	let mut second = NotificationQueue::new();
	second.raise(announcement("beta", NotificationPriority::Normal, T0));
	second.raise(announcement("alpha", NotificationPriority::Normal, T0));
	assert_eq!(keys(&first), keys(&second), "the key breaks the tie, not the arrival order");
}

#[test]
fn an_announcement_goes_when_its_time_is_up_and_an_urgent_one_stays() {
	let mut queue = NotificationQueue::new();
	queue.raise(announcement("low", NotificationPriority::Low, T0));
	queue.raise(announcement("normal", NotificationPriority::Normal, T0));
	queue.raise(announcement("urgent", NotificationPriority::Urgent, T0));

	let low_ttl = NotificationPriority::Low
		.ttl_ms()
		.expect("a low announcement states a lifetime");
	assert_eq!(queue.expire(T0 + low_ttl - 1), 0, "nothing goes before its time");
	assert_eq!(queue.len(), 3);

	assert_eq!(queue.expire(T0 + low_ttl), 1, "the moment it is due, it goes");
	assert_eq!(keys(&queue), ["urgent", "normal"]);

	let normal_ttl = NotificationPriority::Normal
		.ttl_ms()
		.expect("a normal announcement states a lifetime");
	assert_eq!(queue.expire(T0 + normal_ttl), 1);
	assert_eq!(keys(&queue), ["urgent"]);

	assert_eq!(
		queue.expire(T0 + 10_000_000),
		0,
		"an announcement waiting on an answer is not taken away by a clock"
	);
	assert!(queue.holds("urgent"));
}

#[test]
fn every_priority_states_a_lifetime_and_only_the_most_urgent_one_stays() {
	let mut without_expiry = Vec::new();
	for priority in NotificationPriority::iter() {
		let notification = announcement("k", priority, T0);
		if let Some(ttl) = priority.ttl_ms() {
			assert!(ttl > 0, "{priority:?} states a lifetime of no time at all");
			assert_eq!(notification.expires_at_ms(), Some(T0 + ttl));
			assert!(!notification.has_expired(T0 + ttl - 1));
			assert!(
				notification.has_expired(T0 + ttl),
				"{priority:?} is expired at the moment it is due, not a millisecond later"
			);
		} else {
			assert!(!notification.has_expired(u64::MAX));
			without_expiry.push(priority);
		}
	}
	assert_eq!(
		without_expiry,
		[NotificationPriority::Urgent],
		"only an announcement waiting on the operator stays until it is read"
	);
}

#[test]
fn every_source_carries_a_distinct_wire_string() {
	let mut seen = BTreeSet::new();
	for source in NotificationSource::iter() {
		let name = source.as_str();
		assert!(!name.is_empty(), "{source:?} states no wire string");
		assert!(
			name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
			"{source:?} states {name}, which is not a wire string"
		);
		assert!(seen.insert(name), "{source:?} shares its wire string with another source");
	}
	assert_eq!(seen.len(), NotificationSource::iter().count());
}

#[test]
fn a_full_stack_makes_room_by_dropping_the_least_urgent_card() {
	let mut queue = NotificationQueue::new();
	for slot in 0..NOTIFICATION_CAPACITY {
		let key = format!("held-{slot}");
		assert_eq!(
			queue.raise(announcement(&key, NotificationPriority::Low, T0 + slot as u64)),
			Raised::Added
		);
	}
	assert_eq!(queue.len(), NOTIFICATION_CAPACITY);

	let outcome = queue.raise(announcement("urgent", NotificationPriority::Urgent, T0 + 500));
	assert_eq!(
		outcome,
		Raised::Evicted("held-5".to_string()),
		"the card that went is named, so nothing is dropped without a record"
	);
	assert_eq!(queue.len(), NOTIFICATION_CAPACITY, "the bound holds across an eviction");
	assert_eq!(keys(&queue)[0], "urgent");
	assert!(!queue.holds("held-5"));
}

#[test]
fn a_full_stack_of_urgent_cards_refuses_a_routine_one() {
	let mut queue = NotificationQueue::new();
	for slot in 0..NOTIFICATION_CAPACITY {
		let key = format!("waiting-{slot}");
		queue.raise(announcement(&key, NotificationPriority::Urgent, T0 + slot as u64));
	}
	let before = keys(&queue).join(",");

	assert_eq!(
		queue.raise(announcement("routine", NotificationPriority::Normal, T0 + 900)),
		Raised::Refused,
		"a routine announcement does not push an unanswered decision off the stack"
	);
	assert_eq!(keys(&queue).join(","), before, "and the stack is left exactly as it was");
	assert!(!queue.holds("routine"));
}

#[test]
fn a_failing_loop_cannot_grow_the_stack_past_its_bound() {
	let mut queue = NotificationQueue::new();
	for round in 0..500_u64 {
		queue.raise(announcement(&format!("loop-{round}"), NotificationPriority::Normal, T0 + round));
		assert!(
			queue.len() <= NOTIFICATION_CAPACITY,
			"the stack passed its bound at round {round} with {} cards",
			queue.len()
		);
	}
	assert_eq!(queue.len(), NOTIFICATION_CAPACITY, "and it ends full rather than empty");

	// The stack is bounded, and so is the work of raising into it: an
	// announcement that went is gone, so nothing accumulates behind the bound.
	queue.expire(T0 + 500 + NotificationPriority::Normal.ttl_ms().unwrap_or(0));
	assert!(queue.is_empty(), "every routine card has a time, and it ran out");
}

#[test]
fn a_card_is_dismissed_once_and_a_dismissal_of_nothing_says_so() {
	let mut queue = NotificationQueue::new();
	queue.raise(announcement("one", NotificationPriority::Normal, T0));
	queue.raise(announcement("two", NotificationPriority::Normal, T0 + 1));

	assert!(queue.dismiss("one"), "the card that was up went");
	assert!(!queue.dismiss("one"), "and pressing its place again dismisses nothing");
	assert_eq!(keys(&queue), ["two"]);

	queue.clear();
	assert!(queue.is_empty());
	assert_eq!(queue.expire(T0), 0, "an empty stack expires nothing and terminates");
}

#[test]
fn a_full_stack_of_equals_refuses_rather_than_dropping_one_of_them() {
	let mut queue = NotificationQueue::default();
	for slot in 0..NOTIFICATION_CAPACITY {
		queue.raise(announcement(&format!("held-{slot}"), NotificationPriority::Normal, T0));
	}
	assert_eq!(
		queue.raise(announcement("newcomer", NotificationPriority::Normal, T0 + 1)),
		Raised::Refused,
		"a card no more urgent than what is up does not take one of their places: the stack is what \
		 the operator has not read yet, not what happened most recently"
	);
	assert!(!queue.holds("newcomer"));
	assert_eq!(queue.len(), NOTIFICATION_CAPACITY);
	assert!(queue.holds("held-0"), "and the one that has been up longest is still up");
}
