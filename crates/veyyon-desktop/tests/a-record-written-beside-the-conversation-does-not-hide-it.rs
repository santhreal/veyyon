//! WHY: `/btw` wrote its question and its answer into the transcript with no
//! parent stated, and the window drew the answer alone: the transcript is read
//! back along the parent chain of the entry that arrived last, so an entry
//! with no parent is a line of its own and everything said before it left the
//! column. A whole conversation disappeared behind one row.
//!
//! CLASS CLOSED: any producer appending beside the conversation without
//! stating where the transcript had reached. The roles are swept from
//! `MessageRole` at run time, so a role added to the model is covered without
//! an edit here, and the same sweep is run through the reducer the host frames
//! land on rather than against the tree alone. The restate an answer grows by
//! is covered too, because an update that carried the parentless copy back
//! broke the chain a second time after the append had repaired it. The walk is
//! held to terminating on a parent chain that closes a loop.
//!
//! NOT CAUGHT: what the rows are labelled, which is
//! `transcript-roles-retain-their-register-and-searchable-content.rs`; that
//! neither row is recorded in the session file, which is the host's suite
//! `a-question-asked-beside-the-work-is-answered-from-the-same-context.test.
//! ts`; and the pixels, which is `proof/scenes/desktop-side-question.sh`.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator as _;
use support::{NOW_MS, entry};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionId, Store, TranscriptEntry, reduce,
};
use veyyon_desktop_surface::{Block, ShellState, Turn};

const SESSION: &str = "s";

/// A session holding one exchange: what the operator asked, and the reply.
fn conversation() -> Store {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	append(&mut store, vec![
		entry("u1", None, MessageRole::User, text("do it")),
		entry("a1", Some("u1"), MessageRole::Assistant, text("reading")),
	]);
	store
}

fn text(body: &str) -> Vec<ContentBlock> {
	vec![ContentBlock::Text { text: body.to_string() }]
}

fn append(store: &mut Store, entries: Vec<TranscriptEntry>) {
	let revision = entries
		.iter()
		.map(|entry| entry.revision)
		.max()
		.unwrap_or_default();
	reduce(store, HostEvent::TranscriptAppended { revision, entries });
}

/// The record a producer writes beside the conversation, stating no parent.
fn beside(id: &str, role: MessageRole, body: &str) -> TranscriptEntry {
	entry(id, None, role, text(body))
}

fn projected(store: &Store) -> ShellState {
	let mut state = ShellState::default();
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
}

/// Every word the transcript column draws, in the order it draws it.
fn drawn(state: &ShellState) -> String {
	let mut drawn = String::new();
	for turn in &state.transcript {
		match turn {
			Turn::Operator(body) | Turn::OperatorArtifacts { text: body, .. } => {
				drawn.push_str(body);
				drawn.push('\n');
			},
			Turn::Agent { blocks, .. } => {
				for block in blocks {
					match block {
						Block::Prose(body) | Block::Reason(body) | Block::Note { text: body, .. } => {
							drawn.push_str(body);
							drawn.push('\n');
						},
						_ => {},
					}
				}
			},
		}
	}
	drawn
}

#[test]
fn a_record_stating_no_parent_leaves_the_conversation_drawn() {
	for role in MessageRole::iter() {
		let mut store = conversation();
		append(&mut store, vec![beside("r1", role, "a record")]);

		let drawn = drawn(&projected(&store));
		assert!(drawn.contains("do it"), "{role:?} hid what the operator said: {drawn:?}");
		assert!(drawn.contains("reading"), "{role:?} hid the reply: {drawn:?}");
		assert!(drawn.contains("a record"), "{role:?} did not draw the record: {drawn:?}");
	}
}

#[test]
fn a_record_stating_no_parent_is_held_where_it_was_appended() {
	for role in MessageRole::iter() {
		let mut store = conversation();
		append(&mut store, vec![beside("r1", role, "a record")]);

		let tree = &store.transcripts[&SessionId::from(SESSION)];
		let record = tree
			.get(&EntryId::from("r1"))
			.expect("the record is in the tree");
		assert_eq!(
			record.parent,
			Some(EntryId::from("a1")),
			"{role:?} was left off the branch the transcript had reached"
		);
		assert_eq!(
			tree.root_entries,
			vec![EntryId::from("u1")],
			"{role:?} opened a second line of the transcript"
		);
	}
}

#[test]
fn a_pair_written_beside_the_conversation_is_drawn_whole() {
	let mut store = conversation();
	append(&mut store, vec![beside("q", MessageRole::Custom, "which file")]);
	append(&mut store, vec![beside("a", MessageRole::Custom, "")]);

	let drawn = drawn(&projected(&store));
	assert!(drawn.contains("do it") && drawn.contains("reading"), "the exchange left: {drawn:?}");
	assert!(drawn.contains("which file"), "the question is not drawn: {drawn:?}");
}

#[test]
fn an_answer_restated_as_it_grows_stays_on_the_branch_it_was_appended_to() {
	let mut store = conversation();
	append(&mut store, vec![beside("q", MessageRole::Custom, "which file")]);
	append(&mut store, vec![beside("a", MessageRole::Custom, "")]);

	// The producer restates the answer as the provider sends it, and restates
	// it the way it first sent it: content, and no parent.
	for grown in ["src", "src/lib", "src/lib.rs"] {
		let grown = beside("a", MessageRole::Custom, grown);
		reduce(&mut store, HostEvent::TranscriptUpdated {
			revision: grown.revision,
			entry:    grown,
		});
	}

	let drawn = drawn(&projected(&store));
	assert!(drawn.contains("do it") && drawn.contains("reading"), "the exchange left: {drawn:?}");
	assert!(drawn.contains("which file"), "the question left when the answer grew: {drawn:?}");
	assert!(drawn.contains("src/lib.rs"), "the answer is not drawn: {drawn:?}");
	assert_eq!(drawn.matches("src/lib.rs").count(), 1, "the answer is drawn twice: {drawn:?}");
}

#[test]
fn a_parent_chain_that_closes_a_loop_ends_the_walk() {
	// Each entry states the other as its parent, which no producer should
	// send and any of them can. The walk runs off the test's own thread and
	// is given a deadline, because a walk that does not end is a window that
	// never paints again, and a suite that can only read the turns it drew
	// cannot see that.
	let (done, walked) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let mut store = Store::new();
		store.persisted.shell.active_session = Some(SessionId::from(SESSION));
		append(&mut store, vec![
			entry("a", Some("b"), MessageRole::Assistant, text("first")),
			entry("b", Some("a"), MessageRole::Assistant, text("second")),
		]);
		let state = projected(&store);
		let _ = done.send((state.transcript.len(), drawn(&state)));
	});

	let Ok((turns, drawn)) = walked.recv_timeout(std::time::Duration::from_secs(2)) else {
		panic!("the walk of a looping parent chain did not end");
	};
	assert_eq!(turns, 1, "a looping chain reads as one agent turn");
	assert!(drawn.contains("first") && drawn.contains("second"), "drew {drawn:?}");
	assert_eq!(drawn.matches("second").count(), 1, "the loop was walked twice: {drawn:?}");
}
