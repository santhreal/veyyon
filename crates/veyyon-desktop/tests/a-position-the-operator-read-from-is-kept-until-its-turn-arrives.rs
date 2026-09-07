//! WHY: §8.10 remembers where the operator was reading and which cards they
//! had open, and the turn either one names is often not on the window when it
//! is read: a relaunch restores the store before the host has sent the
//! transcript, and a session pages in earlier turns afterwards. A value
//! applied only on the frame it arrives on is a value silently dropped, and a
//! position applied as an index lands on whatever turn later occupies that
//! slot.
//!
//! The class this closes is a remembered value that names something the host
//! has not reported yet: it is held while it cannot be placed, written back to
//! the store as held, resolved against the id the host reports rather than an
//! index, and applied on the frame the thing it names is drawn.
//!
//! What it does not catch: the document these values are written in, which is
//! the model crate's sweep, and the placement of a value whose turn is already
//! drawn, which the shape suite covers.

mod support;

use std::collections::HashMap;

use support::{
	NOW_MS, entry,
	memory::{FIRST, driven, keeper_over, store_on},
};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{SessionShape, ShellState};

#[test]
fn a_reading_position_naming_a_turn_that_has_not_arrived_is_kept_until_it_does() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-pending-anchor");
	driven(support::memory::crowded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
			})
			.expect("the keeper adopts the session the host named");
		let shape = SessionShape {
			scroll_anchor: Some(veyyon_desktop_surface::ScrollAnchor {
				entry_id:  "entry-later".to_string(),
				offset_px: 6.0,
			}),
			..SessionShape::default()
		};
		session
			.update(|view, _window, cx| view.restore_session_shape(&shape, cx))
			.expect("the window takes a position naming a turn it has not drawn");
		session
			.frame()
			.expect("a frame with the turn still missing draws");
		let held = session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 1, cx);
				view.session_shape().scroll_anchor
			})
			.expect("the window states what it is still holding");
		assert_eq!(
			held.as_ref().map(|anchor| anchor.entry_id.as_str()),
			Some("entry-later"),
			"a position whose turn has not arrived is kept, not dropped"
		);

		// The turn the position names arrives, which is the transcript being
		// paged in behind the window.
		session
			.update(|view, _window, _cx| {
				let state = view.state_mut();
				state
					.transcript
					.push(veyyon_desktop_surface::Turn::Operator(
						"the turn the anchor names".to_string(),
					));
				state.turn_anchors.push("entry-later".to_string());
			})
			.expect("the host's transcript reaches the window");
		session
			.frame()
			.expect("the frame that draws it applies the position");
		let placed = session
			.update(|view, _window, _cx| {
				(
					view.transcript_viewport().logical_scroll_top().item_ix,
					view.session_shape().scroll_anchor,
				)
			})
			.expect("the window states where it placed the view");
		let expected = session
			.update(|view, _window, _cx| view.state().turn_anchors.len() - 1)
			.expect("the window states how many turns it holds");
		assert_eq!(placed.0, expected, "the position landed on the turn it named");
		assert_eq!(
			placed.1.map(|anchor| anchor.entry_id),
			Some("entry-later".to_string()),
			"the position it placed is the position it now reports"
		);
	});
}

#[test]
fn every_turn_the_transcript_draws_names_the_entry_that_opened_it() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("u1", None, MessageRole::User, vec![ContentBlock::Text {
		text: "the first prompt".to_string(),
	}]));
	// Three entries the agent produced, which the operator reads as one turn,
	// so the turn is anchored by the first of them and not the last.
	tree.append(entry("a1", Some("u1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "thinking about it".to_string(),
	}]));
	tree.append(entry("skipped", Some("a1"), MessageRole::Assistant, vec![]));
	tree.append(entry("a2", Some("skipped"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "done".to_string(),
	}]));
	tree.append(entry("u2", Some("a2"), MessageRole::User, vec![ContentBlock::Text {
		text: "the second prompt".to_string(),
	}]));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(
		state.turn_anchors.len(),
		state.transcript.len(),
		"a turn without an anchor is a turn a remembered position cannot name"
	);
	assert_eq!(
		state.turn_anchors,
		vec!["u1".to_string(), "a1".to_string(), "u2".to_string()],
		"each turn names the entry it was opened by, and an entry that drew nothing names no turn"
	);
}

#[test]
fn a_view_at_the_live_edge_remembers_no_position_and_a_return_to_it_forgets_one() {
	driven(support::memory::crowded(), |session| {
		session
			.frame()
			.expect("a transcript longer than the window draws");
		let at_edge = session
			.update(|view, _window, _cx| {
				(
					view.transcript_viewport().is_following_tail(),
					view.session_shape().scroll_anchor,
				)
			})
			.expect("the window states where it is reading");
		assert!(at_edge.0, "a transcript nothing scrolled follows the live edge");
		assert_eq!(
			at_edge.1, None,
			"a view at the live edge remembers no position, so it comes back at the edge \
			 however far the turn ran on"
		);

		let read_back = session
			.update(|view, _window, _cx| {
				view.transcript_viewport().scroll_to_offset(3, 5.0);
				(
					view.state().turn_anchors.get(3).cloned(),
					view.session_shape().scroll_anchor,
				)
			})
			.expect("the window states the position it was read from");
		assert_eq!(
			read_back.1.map(|anchor| anchor.entry_id),
			read_back.0,
			"reading back off the edge leaves the entry the top turn was opened by"
		);

		let returned = session
			.update(|view, _window, _cx| {
				view.transcript_viewport().scroll_to_end();
				view.session_shape().scroll_anchor
			})
			.expect("the window states what it holds after the jump to the edge");
		assert_eq!(
			returned, None,
			"a view the operator sent back to the live edge forgets the position it left"
		);
	});
}

#[test]
fn a_disclosure_naming_an_invocation_that_has_not_arrived_is_kept_until_it_does() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-pending-disclosure");
	driven(support::memory::crowded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
			})
			.expect("the keeper adopts the session the host named");
		let shape = SessionShape {
			expanded_call_ids: std::iter::once(
				support::memory::CALL_WITH_VIEWS.to_string(),
			)
			.collect(),
			..SessionShape::default()
		};
		session
			.update(|view, _window, cx| view.restore_session_shape(&shape, cx))
			.expect("the window takes a disclosure naming a card it has not drawn");
		session
			.frame()
			.expect("a frame with the invocation still missing draws");
		let held = session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 1, cx);
				view.session_shape().expanded_call_ids
			})
			.expect("the window states what it is still holding");
		assert!(
			held.contains(support::memory::CALL_WITH_VIEWS),
			"a disclosure whose invocation has not arrived is kept, not dropped: {held:?}"
		);
	});
}
