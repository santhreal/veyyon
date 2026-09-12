//! WHY: §0 names five queue sections and the product could reach four.
//! `Unsent` was a `QueuePartition` variant, so it could only be entered by a
//! placement, and nothing placed a session there: no intent, no chord, no
//! reducer arm. A prompt typed into one session and left unsent was invisible
//! from every other session, and the section's header, card shape and ordering
//! were dead code that no state could produce.
//!
//! CLASS CLOSED: a rail section the plan declares that no state produces. The
//! sweep enumerates `Section::all()` at run time and drives the shipped
//! `project` for each one, so a sixth section fails here until some store
//! state draws it. The membership rule is asserted in both directions — a
//! drafted session appears under `Unsent` and leaves the partition it is
//! placed in, so no session is drawn twice — and the row carries the placement
//! its partition chord toggles against, which is what keeps `P` on a lifted
//! pinned row an unpin.
//!
//! NOT CAUGHT: whether the rail draws the section it is handed; the surface
//! crate's pixel suites own that. Whether the draft reaches the disk and comes
//! back; `what-the-window-remembers-reaches-the-disk-and-comes-back.rs` owns
//! that. Whether the answer to a submission names the session that submitted;
//! `composer-submission.rs` in the surface crate owns that, and this suite
//! owns only what the store does once it is named.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, project, project::clear_sent_draft};
use veyyon_desktop_model::{ComposerStore, QueuePartition, SessionId, Store};
use veyyon_desktop_surface::{Row, Section, ShellState};

/// A store holding one session per named id, each in `partition`.
fn store_with(ids: &[(&str, QueuePartition)]) -> Store {
	let mut store = Store::new();
	for (index, (id, partition)) in ids.iter().enumerate() {
		let mut seeded = session(id, *partition);
		// Distinct creation times, oldest first, so the `Unsent` order is
		// observable rather than a tie broken by id.
		seeded.created_at_ms = NOW_MS - 500_000 + (index as u64) * 1_000;
		store.sessions.insert(seeded);
	}
	store
}

/// Records `text` as the draft the window holds for `id`.
fn draft(store: &mut Store, id: &str, text: &str) {
	store
		.persisted
		.composer
		.insert(SessionId::from(id), ComposerStore {
			draft_text: text.to_string(),
			..ComposerStore::default()
		});
}

/// The sections the shipped projection draws, in order, with their rows.
fn drawn(store: &Store) -> Vec<(Section, Vec<Row>)> {
	drawn_through(store, &mut SessionIndex::new())
}

/// The rows one section holds, or an empty run when the section is not drawn.
fn rows_of(sections: &[(Section, Vec<Row>)], wanted: Section) -> Vec<Row> {
	sections
		.iter()
		.find(|(section, _)| *section == wanted)
		.map(|(_, rows)| rows.clone())
		.unwrap_or_default()
}

/// A store state that draws `section`.
///
/// The match is exhaustive over `Section`, so a section added to the rail
/// fails to compile here until someone states the state that reaches it.
fn state_drawing(section: Section) -> Store {
	let placement = match section {
		// The one section no placement produces: a session in play, left with
		// a draft, and not the one the operator is looking at.
		Section::Unsent => {
			let mut store = store_with(&[("drafted", QueuePartition::Live)]);
			draft(&mut store, "drafted", "the half-written prompt");
			return store;
		},
		Section::Pinned => QueuePartition::Pinned,
		Section::Live => QueuePartition::Live,
		Section::Deferred => QueuePartition::Deferred,
		Section::Parked => QueuePartition::Parked,
	};
	store_with(&[("placed", placement)])
}

#[test]
fn every_section_the_rail_declares_is_one_some_state_draws() {
	let unreachable: Vec<Section> = Section::all()
		.into_iter()
		.filter(|section| rows_of(&drawn(&state_drawing(*section)), *section).is_empty())
		.collect();
	assert_eq!(
		unreachable,
		Vec::new(),
		"a section the rail draws a header, a row shape and an order for, that no state reaches"
	);
}

#[test]
fn a_drafted_session_is_stated_once_under_unsent_and_not_where_it_is_placed() {
	for placement in [QueuePartition::Pinned, QueuePartition::Live] {
		let mut store = store_with(&[("drafted", placement), ("clean", placement)]);
		draft(&mut store, "drafted", "left half-written");
		draft(&mut store, "clean", "   \n\t ");
		let sections = drawn(&store);

		let unsent = rows_of(&sections, Section::Unsent);
		assert_eq!(unsent.len(), 1, "{placement:?}: one drafted session, one unsent row");
		assert_eq!(unsent[0].title, "title drafted", "{placement:?}: the wrong session was lifted");
		assert_eq!(
			unsent[0].placement,
			match placement {
				QueuePartition::Pinned => Section::Pinned,
				_ => Section::Live,
			},
			"{placement:?}: a lifted row must name the partition its chord toggles against"
		);

		let drawn_ids: Vec<u64> = sections
			.iter()
			.flat_map(|(_, rows)| rows.iter().map(|row| row.id))
			.collect();
		let mut unique = drawn_ids.clone();
		unique.sort_unstable();
		unique.dedup();
		assert_eq!(
			drawn_ids.len(),
			unique.len(),
			"{placement:?}: a lifted session is drawn twice, so the rail holds two rows one click \
			 cannot tell apart"
		);

		// A draft of nothing but whitespace is no draft: it is what a cleared
		// composer leaves behind.
		let placed = rows_of(&sections, match placement {
			QueuePartition::Pinned => Section::Pinned,
			_ => Section::Live,
		});
		assert_eq!(
			placed
				.iter()
				.map(|row| row.title.clone())
				.collect::<Vec<_>>(),
			vec!["title clean".to_string()],
			"{placement:?}: only the drafted session leaves its partition"
		);
	}
}

#[test]
fn the_session_being_typed_in_stays_where_it_is_placed() {
	let mut store = store_with(&[("open", QueuePartition::Live)]);
	draft(&mut store, "open", "still typing this");
	store.persisted.shell.active_session = Some(SessionId::from("open"));

	let sections = drawn(&store);
	assert!(
		rows_of(&sections, Section::Unsent).is_empty(),
		"§5.2 re-orders the rail on unpark, recall and pin alone: a keystroke must not move the \
		 open session's row into another section under the operator"
	);
	assert_eq!(rows_of(&sections, Section::Live).len(), 1, "the open session keeps its row");
}

#[test]
fn a_session_set_aside_keeps_its_draft_where_it_was_set_aside() {
	for placement in [QueuePartition::Deferred, QueuePartition::Parked] {
		let mut store = store_with(&[("aside", placement)]);
		draft(&mut store, "aside", "written before it was set aside");
		let sections = drawn(&store);

		assert!(
			rows_of(&sections, Section::Unsent).is_empty(),
			"{placement:?}: a session set aside deliberately must not be pulled back to the top of \
			 the rail by leftover draft text"
		);
		let kept = rows_of(&sections, match placement {
			QueuePartition::Deferred => Section::Deferred,
			_ => Section::Parked,
		});
		assert_eq!(kept.len(), 1, "{placement:?}: the session left the section it was set aside in");
	}
}

#[test]
fn unsent_rows_run_newest_first() {
	let mut store = store_with(&[
		("oldest", QueuePartition::Live),
		("middle", QueuePartition::Live),
		("newest", QueuePartition::Live),
	]);
	for id in ["oldest", "middle", "newest"] {
		draft(&mut store, id, "held");
	}

	let titles: Vec<String> = rows_of(&drawn(&store), Section::Unsent)
		.iter()
		.map(|row| row.title.clone())
		.collect();
	assert_eq!(
		titles,
		vec!["title newest".to_string(), "title middle".to_string(), "title oldest".to_string(),],
		"§0 orders `Unsent` newest first"
	);
}

#[test]
fn a_draft_under_a_session_the_host_no_longer_lists_draws_no_row() {
	let mut store = store_with(&[("live", QueuePartition::Live)]);
	draft(&mut store, "gone", "text for a session that is not there");

	let sections = drawn(&store);
	assert!(
		rows_of(&sections, Section::Unsent).is_empty(),
		"a draft whose session the store cannot resolve is no row: the title would be invented"
	);
	assert_eq!(rows_of(&sections, Section::Live).len(), 1, "the listed session still draws");
}

/// The sections drawn against a caller's index, so a minted row id survives
/// to the next projection.
fn drawn_through(store: &Store, index: &mut SessionIndex) -> Vec<(Section, Vec<Row>)> {
	let mut state = ShellState::default();
	project(store, index, &HashMap::new(), NOW_MS, &mut state);
	state.sections
}

#[test]
fn a_prompt_the_host_took_leaves_the_unsent_section() {
	let mut store = store_with(&[("sent", QueuePartition::Live), ("kept", QueuePartition::Live)]);
	draft(&mut store, "sent", "the prompt that went");
	draft(&mut store, "kept", "the prompt still waiting");

	let mut index = SessionIndex::new();
	assert_eq!(
		rows_of(&drawn_through(&store, &mut index), Section::Unsent).len(),
		2,
		"both drafted sessions are unsent before either is submitted"
	);
	let row = index
		.row_id(&SessionId::from("sent"))
		.expect("a drawn session has a row");

	clear_sent_draft(&mut store, &index, row);

	let sections = drawn_through(&store, &mut index);
	assert_eq!(
		rows_of(&sections, Section::Unsent)
			.iter()
			.map(|row| row.title.clone())
			.collect::<Vec<_>>(),
		vec!["title kept".to_string()],
		"a prompt the host took is no longer unsent, and no other session's draft goes with it"
	);
	assert_eq!(
		store
			.persisted
			.composer
			.get(&SessionId::from("kept"))
			.map(|composer| composer.draft_text.as_str()),
		Some("the prompt still waiting"),
		"clearing one session's draft must not reach another's"
	);
	assert_eq!(
		rows_of(&sections, Section::Live)
			.iter()
			.filter(|row| row.title == "title sent")
			.count(),
		1,
		"the session comes back to the partition it is placed in"
	);
}

#[test]
fn a_row_no_session_answers_for_clears_no_draft() {
	let mut store = store_with(&[("live", QueuePartition::Live)]);
	draft(&mut store, "live", "held");
	let mut index = SessionIndex::new();
	drawn_through(&store, &mut index);
	let before = store.persisted.composer.clone();

	// Zero is the id of no session, and nothing has minted a row this high.
	for row in [0_u64, 99] {
		clear_sent_draft(&mut store, &index, row);
		assert_eq!(
			store.persisted.composer, before,
			"row {row} stands for no session, so it clears nothing"
		);
	}
}
