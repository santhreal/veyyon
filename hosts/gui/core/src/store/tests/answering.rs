//! WHY THIS SUITE EXISTS.
//! An answer arrives in pieces, over time, for a conversation the reader may
//! have left. Every one of those is a way to write the answer into the wrong
//! place or to draw it half parsed: into whatever is selected instead of what
//! was asked, as a fence that never closes because each delta was parsed on its
//! own, or as a spinner that turns forever because the end of an answer was
//! taken for a conversation that had none. This suite drives the moves an
//! engine will call, in the order a transport calls them, including out of
//! order.
//!
//! WHAT IT DOES NOT CATCH. The transport: no engine is attached, so nothing
//! proves the deltas a real one sends are the deltas these moves take, and
//! nothing here draws the result. The seam is store-side only.

use super::{
	super::{
		model::{Block, Role, SessionId, Store},
		moves,
	},
	store,
};
use crate::text::markdown::Md;

/// The conversation the fixture opens with.
fn first(store: &Store) -> SessionId {
	store
		.selected
		.clone()
		.expect("the fixture opens with a conversation")
}

/// The blocks of the last message in a conversation.
fn last_blocks(store: &Store, id: &SessionId) -> Vec<Block> {
	store
		.sessions
		.iter()
		.find(|session| &session.id == id)
		.and_then(|session| session.messages.last())
		.map(|message| message.blocks.clone())
		.unwrap_or_default()
}

#[test]
fn an_answer_is_written_into_the_conversation_it_was_asked_in() {
	// The defect this closes: an answer written into whatever is on screen. The
	// reader asks in one conversation, switches to another, and the answer
	// arrives: it belongs to the first one, and the second one stays empty.
	let mut store = store();
	let asked = first(&store);
	moves::new_session(&mut store);
	let reading = first(&store);
	assert_ne!(asked, reading);

	moves::begin_answer(&mut store, &asked, 10).expect("an answer opens");
	assert!(moves::extend_answer(&mut store, &asked, "the answer", 20));
	assert!(moves::finish_answer(&mut store, &asked));

	let answered = store
		.sessions
		.iter()
		.find(|session| session.id == asked)
		.unwrap();
	assert_eq!(answered.messages.len(), 1);
	assert_eq!(answered.messages[0].role, Role::Engine);
	assert_eq!(answered.messages[0].text(), "the answer");
	let elsewhere = store
		.sessions
		.iter()
		.find(|session| session.id == reading)
		.unwrap();
	assert!(elsewhere.messages.is_empty(), "the answer landed in the conversation being read");
}

#[test]
fn a_fence_split_across_deltas_ends_as_one_block_of_code() {
	// The defect: parsing each delta on its own. A fence opens in one delta and
	// closes in another, and per-delta parsing draws the opening line as prose
	// and the code as prose after it. Every intermediate state is checked too,
	// since a half-arrived fence is on screen for as long as the engine takes.
	let mut store = store();
	let id = first(&store);
	moves::begin_answer(&mut store, &id, 10).expect("an answer opens");

	for delta in ["here it is\n\n```rust\n", "fn main() {\n", "}\n"] {
		assert!(moves::extend_answer(&mut store, &id, delta, 20));
	}
	// Still open: the text so far is prose and an unclosed fence, which parses
	// to something drawable rather than to nothing.
	assert!(!last_blocks(&store, &id).is_empty(), "a half-arrived answer draws nothing");

	assert!(moves::extend_answer(&mut store, &id, "```\n", 30));
	assert!(moves::finish_answer(&mut store, &id));

	let blocks = last_blocks(&store, &id);
	let [Block::Prose(prose)] = blocks.as_slice() else {
		panic!("an answer is prose and fences: {blocks:?}");
	};
	let fences = prose
		.iter()
		.filter(|block| matches!(block, Md::Code { .. }))
		.count();
	assert_eq!(fences, 1, "the fence did not close as one block: {prose:?}");
	let code = prose
		.iter()
		.find_map(|block| match block {
			Md::Code { lang, body } => Some((body.clone(), lang.clone())),
			_ => None,
		})
		.unwrap();
	assert_eq!(code.0, "fn main() {\n}");
	assert_eq!(code.1, "rust");
}

#[test]
fn an_answer_turns_until_it_is_finished_and_then_stops() {
	// The spinner is drawn from `streaming`, so this is the assertion that it
	// terminates: it is on while the answer is open, including after a delta,
	// and off the moment the answer ends.
	let mut store = store();
	let id = first(&store);
	let message = moves::begin_answer(&mut store, &id, 10).expect("an answer opens");

	let streaming = |store: &Store| {
		store
			.sessions
			.iter()
			.find(|session| session.id == id)
			.unwrap()
			.messages
			.iter()
			.find(|candidate| candidate.id == message)
			.unwrap()
			.streaming
	};
	assert!(streaming(&store), "an answer that has just opened is not turning");
	moves::extend_answer(&mut store, &id, "half of it", 20);
	assert!(streaming(&store));

	assert!(moves::finish_answer(&mut store, &id));
	assert!(!streaming(&store), "the answer finished and the spinner kept turning");
}

#[test]
fn a_delta_or_an_end_for_an_answer_that_was_never_opened_is_refused() {
	// A transport that sends an end twice, or a delta after one, is a transport
	// with a defect: the moves say no rather than opening a message of their own
	// or writing into the last one, which would put an engine's words inside
	// what the operator wrote.
	let mut store = store();
	let id = first(&store);
	assert!(!moves::extend_answer(&mut store, &id, "nobody asked", 10));
	assert!(!moves::finish_answer(&mut store, &id));

	moves::begin_answer(&mut store, &id, 10).expect("an answer opens");
	assert!(moves::finish_answer(&mut store, &id));
	assert!(!moves::finish_answer(&mut store, &id), "the same answer ended twice");
	assert!(!moves::extend_answer(&mut store, &id, "after the end", 20));

	let session = store
		.sessions
		.iter()
		.find(|session| session.id == id)
		.unwrap();
	assert_eq!(session.messages.len(), 1, "a refused delta wrote a message anyway");
	assert_eq!(session.messages[0].text(), "");
}

#[test]
fn a_second_answer_in_one_conversation_is_refused_while_the_first_is_open() {
	// Two answers at once is one question sent twice. The first keeps the
	// message, so a delta already on its way is not written into a message that
	// was replaced underneath it.
	let mut store = store();
	let id = first(&store);
	let first_message = moves::begin_answer(&mut store, &id, 10).expect("an answer opens");

	assert_eq!(moves::begin_answer(&mut store, &id, 20), None);
	assert!(moves::extend_answer(&mut store, &id, "into the first", 30));
	assert!(moves::finish_answer(&mut store, &id));

	let session = store
		.sessions
		.iter()
		.find(|session| session.id == id)
		.unwrap();
	assert_eq!(session.messages.len(), 1, "the second answer opened a message of its own");
	assert_eq!(session.messages[0].id, first_message);
	assert_eq!(session.messages[0].text(), "into the first");
}

#[test]
fn an_answer_for_a_conversation_that_is_gone_is_refused_at_every_step() {
	// The conversation can be deleted while an answer is arriving, and a
	// transport does not know that yet. Every move takes the missing id and says
	// no, rather than reaching for the selected conversation.
	let mut store = store();
	let id = first(&store);
	moves::new_session(&mut store);
	moves::begin_answer(&mut store, &id, 10).expect("an answer opens");
	moves::extend_answer(&mut store, &id, "half of it", 20);

	moves::delete_session(&mut store, &id);

	assert_eq!(moves::begin_answer(&mut store, &id, 30), None);
	assert!(!moves::extend_answer(&mut store, &id, "the rest", 40));
	assert!(!moves::finish_answer(&mut store, &id));
	assert!(
		store
			.sessions
			.iter()
			.all(|session| session.messages.is_empty()),
		"the answer was written into another conversation"
	);
}

#[test]
fn an_answer_that_ends_badly_keeps_what_arrived_and_says_why_once() {
	// A failure is not a message. What arrived stays in the transcript, the
	// spinner stops, and the reason is a notice: a transcript is what was said,
	// and a transport failure was said by nobody.
	let mut store = store();
	let id = first(&store);
	moves::begin_answer(&mut store, &id, 10).expect("an answer opens");
	moves::extend_answer(&mut store, &id, "as far as it got", 20);

	assert!(moves::fail_answer(&mut store, &id, "The engine stopped answering."));

	let session = store
		.sessions
		.iter()
		.find(|session| session.id == id)
		.unwrap();
	assert_eq!(session.messages.len(), 1, "the failure became a message");
	assert_eq!(session.messages[0].text(), "as far as it got");
	assert!(!session.messages[0].streaming, "the failed answer is still turning");
	assert_eq!(store.notice.as_deref(), Some("The engine stopped answering."));
}

#[test]
fn an_answer_moves_its_conversation_to_the_front_of_the_list() {
	// The list is ordered by when a conversation was last touched, and an answer
	// touches it: a conversation that answered while the reader was elsewhere is
	// at the top when they come back.
	let mut store = store();
	let older = first(&store);
	moves::new_session(&mut store);
	let newer = first(&store);
	assert_eq!(store.visible_order().first(), Some(&newer));

	moves::begin_answer(&mut store, &older, 100);
	moves::extend_answer(&mut store, &older, "over here", 200);

	assert_eq!(
		store.visible_order().first(),
		Some(&older),
		"the conversation that answered stayed where it was in the list"
	);
}
