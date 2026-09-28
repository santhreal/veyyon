//! The sidebar listing, the transcript cache and opening a session.

use std::{cell::RefCell, rc::Rc};

use veyyon_desktop_app::{AppState, StoreEvent, TRANSCRIPT_CACHE_SESSIONS};
use veyyon_desktop_model::{HostAction, HostEvent, Store};
use veyyon_gpui::{AppContext as _, TestAppContext};

use super::{displayed_ids, listing, opened, resets, sid, summary};

/// Each project as `(name, path, [(session, depth)])`.
type Listed<'a> = Vec<(&'a str, &'a str, Vec<(&'a str, usize)>)>;

#[test]
fn projects_group_sessions_by_cwd_newest_first_with_branches_under_their_parent() {
	let mut state = AppState::new(Store::new());
	let index = || {
		listing(vec![
			summary("a", "/w/alpha", 100, None),
			summary("b", "/w/alpha/", 300, None),
			summary("c", "/w/beta", 200, None),
			summary("d", "/w/alpha", 50, Some("a")),
			summary("e", "/w/beta", 400, Some("a")),
		])
	};
	assert_eq!(state.reduce_batch(vec![index()]), vec![StoreEvent::SessionsChanged]);

	let listed: Listed<'_> = state
		.projects()
		.iter()
		.map(|project| {
			let rows = project
				.sessions
				.iter()
				.map(|row| (row.id.0.as_str(), row.depth))
				.collect();
			(project.name.as_str(), project.path.as_str(), rows)
		})
		.collect();
	// `b` reports its directory with a trailing separator and still joins
	// `alpha`; `e` branches from a session of another project and is listed
	// as a session of its own.
	assert_eq!(listed, vec![
		("beta", "/w/beta", vec![("e", 0), ("c", 0)]),
		("alpha", "/w/alpha", vec![("b", 0), ("a", 0), ("d", 1)]),
	]);
	assert_eq!(state.cwd(&sid("d")), Some("/w/alpha"));

	assert_eq!(state.reduce_batch(vec![index()]), Vec::<StoreEvent>::new(), "an unchanged index");
}

#[test]
fn the_cache_evicts_the_least_recently_used_of_nine_sessions() {
	let mut state = AppState::new(Store::new());
	let names: Vec<String> = (0..=TRANSCRIPT_CACHE_SESSIONS)
		.map(|ix| format!("s{ix}"))
		.collect();
	for name in &names[..TRANSCRIPT_CACHE_SESSIONS] {
		state.reduce_batch(opened(name, 1, 2));
	}
	assert!(
		names[..TRANSCRIPT_CACHE_SESSIONS]
			.iter()
			.all(|name| state.is_cached(&sid(name)))
	);

	state.reduce_batch(opened(&names[TRANSCRIPT_CACHE_SESSIONS], 1, 2));
	assert!(!state.is_cached(&sid("s0")));
	assert_eq!(state.entry_count(&sid("s0")), 0);
	assert!(!state.store().transcripts.contains_key(&sid("s0")));
	assert!(names[1..].iter().all(|name| state.is_cached(&sid(name))));
	assert_eq!(displayed_ids(&state, "s8"), ["s8-0", "s8-1"]);
}

#[test]
fn reopening_a_session_at_an_unchanged_revision_emits_no_reset() {
	let cx = TestAppContext::single();
	let state = cx.update(|app| app.new(|_| AppState::new(Store::new())));
	let seen: Rc<RefCell<Vec<StoreEvent>>> = Rc::default();
	cx.update(|app| {
		let seen = Rc::clone(&seen);
		app.subscribe(&state, move |_, event: &StoreEvent, _| seen.borrow_mut().push(event.clone()))
			.detach();
	});
	let apply = |events: Vec<HostEvent>| {
		cx.update(|app| state.update(app, |state, cx| state.apply(events, cx)));
		seen.take()
	};

	assert_eq!(resets(&apply(opened("a", 5, 3))).len(), 1);
	assert_eq!(resets(&apply(opened("b", 2, 1))).len(), 1);

	let request = cx.update(|app| state.update(app, |state, cx| state.open_session(sid("a"), cx)));
	assert_eq!(seen.take(), vec![
		StoreEvent::OutboxReady,
		StoreEvent::ActiveSessionChanged,
		StoreEvent::TranscriptReset { session: sid("a") },
	]);
	cx.update(|app| {
		let state = state.read(app);
		assert_eq!(state.active_session(), Some(&sid("a")));
		assert_eq!(displayed_ids(state, "a"), ["a-0", "a-1", "a-2"], "rendered from the cache");
		assert!(state.registry().get(&request).is_some());
	});
	let outbox = cx.update(|app| state.update(app, |state, _| state.drain_outbox()));
	assert_eq!(outbox.len(), 1);
	assert_eq!(outbox[0].id, request);
	assert_eq!(outbox[0].action, HostAction::OpenSession { session: sid("a") });

	let answer = apply(opened("a", 5, 3));
	assert!(
		!answer.iter().any(|event| matches!(
			event,
			StoreEvent::TranscriptReset { .. } | StoreEvent::ActiveSessionChanged
		)),
		"{answer:?}"
	);
	assert_eq!(apply(vec![HostEvent::RequestSucceeded { request }]), vec![
		StoreEvent::RequestFinished { request, ok: true },
	]);
	cx.update(|app| assert!(state.read(app).registry().is_empty()));

	// The host's transcript at a newer revision replaces the cached one.
	assert_eq!(resets(&apply(opened("a", 6, 4))).len(), 1);
}
