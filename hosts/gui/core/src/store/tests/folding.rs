//! WHY THIS SUITE EXISTS.
//!
//! A tool call carries its output behind a fold, and the fold has two answers
//! in it: what the window opens with, and what the reader said afterwards. The
//! defect class is a fold that is one of those and not both. A fold with no
//! reader in it is a chevron that does nothing, so a successful call's output
//! is unreachable and the transcript cannot be checked against what happened. A
//! fold with no default in it opens every call at once, or hides a failure's
//! text behind a press nobody knows to make. The third member is a reader's
//! answer that a later state change overwrites: a call unfolded while it ran
//! folding itself on finishing, which reads as the window closing something the
//! reader opened.
//!
//! Every [`ToolState`] is swept, so a state added later turns this red until
//! its default is a decision rather than whatever the last arm said.
//!
//! WHAT IT DOES NOT CATCH. That the transcript wires the press: `applies` and
//! the move are proved here, and a row drawn with no listener would pass. It
//! also says nothing about the chevron's own drawing, which only a reader can
//! judge.

use super::{
	super::{
		model::{Block, Message, Role, SessionId, Store, ToolCall, ToolKind, ToolState},
		moves,
	},
	store,
};
use crate::command::Command;

/// Every state a call can be in, from the enum rather than from memory.
fn states() -> Vec<ToolState> {
	vec![
		ToolState::Running,
		ToolState::Done,
		ToolState::Failed("exit 1".to_owned()),
		ToolState::Waiting,
	]
}

fn tool(id: &str, state: ToolState, detail: &str) -> ToolCall {
	ToolCall {
		id: id.to_owned(),
		kind: ToolKind::Ran,
		what: "cargo test".to_owned(),
		detail: detail.to_owned(),
		state,
		open: None,
	}
}

/// A store whose selected conversation holds one call.
fn with_call(call: ToolCall) -> (Store, SessionId) {
	let mut store = store();
	let id = store
		.selected
		.clone()
		.expect("the fixture opens with a conversation");
	let message = Message {
		id:        1,
		role:      Role::Engine,
		blocks:    vec![Block::Tool(call)],
		at_ms:     0,
		streaming: false,
	};
	store
		.session_mut(&id)
		.expect("the selected conversation is in the store")
		.messages
		.push(message);
	(store, id)
}

fn call_in(store: &Store, id: &str) -> ToolCall {
	store
		.tool_call(id)
		.cloned()
		.expect("the call is in the conversation on screen")
}

#[test]
fn only_a_failure_shows_its_output_without_being_asked() {
	// Pinned per state, so a new state cannot inherit "open" by sitting next to
	// the failure arm in a match.
	for state in states() {
		let failed = matches!(state, ToolState::Failed(_));
		let (store, _) = with_call(tool("t1", state.clone(), "line one\nline two"));
		assert_eq!(
			call_in(&store, "t1").unfolded(),
			failed,
			"{state:?} decides the fold it opens with"
		);
	}
}

#[test]
fn a_call_that_produced_nothing_has_nothing_to_unfold() {
	// The defect: a chevron on a row with an empty body, which opens onto a gap.
	// Asserted for every state, including the failure that would otherwise open
	// itself.
	for state in states() {
		let (store, _) = with_call(tool("t1", state.clone(), "   \n\t"));
		let call = call_in(&store, "t1");
		assert!(!call.has_detail(), "{state:?} with blank output has no body");
		assert!(!call.unfolded(), "{state:?} with blank output stays folded");
		assert!(
			!Command::ToggleTool("t1".to_owned()).applies(&store),
			"{state:?} with blank output offers no fold"
		);
	}
}

#[test]
fn an_explicit_answer_cannot_unfold_an_empty_body() {
	// The invariant the drawing depends on: unfolded implies there is something
	// to draw. Without it a stale answer written before the output was cleared
	// opens an empty well.
	let (mut store, id) = with_call(tool("t1", ToolState::Done, ""));
	if let Some(Block::Tool(call)) = store
		.session_mut(&id)
		.expect("the conversation is there")
		.messages
		.last_mut()
		.and_then(|message| message.blocks.first_mut())
	{
		call.open = Some(true);
	}
	assert!(!call_in(&store, "t1").unfolded());
}

#[test]
fn output_arriving_later_does_not_spring_a_row_open() {
	// An engine writes the line before it writes what the line produced, so a
	// press that lands in that window must not leave an answer behind. Without
	// the move's own guard the row opens itself the moment the output arrives,
	// which reads as the transcript unfolding on its own.
	let (mut store, id) = with_call(tool("t1", ToolState::Running, ""));
	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert_eq!(call_in(&store, "t1").open, None, "nothing was decided about a row with no body");

	if let Some(Block::Tool(call)) = store
		.session_mut(&id)
		.expect("the conversation is there")
		.messages
		.last_mut()
		.and_then(|message| message.blocks.first_mut())
	{
		call.detail = "output".to_owned();
		call.state = ToolState::Done;
	}
	assert!(!call_in(&store, "t1").unfolded(), "the row is where it was left");
}

#[test]
fn pressing_the_row_shows_the_output_and_pressing_again_hides_it() {
	// The defect this closes: a fold whose only input is the state, so a
	// successful call's output is unreachable.
	let (mut store, _) = with_call(tool("t1", ToolState::Done, "output"));
	assert!(Command::ToggleTool("t1".to_owned()).applies(&store));

	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert!(call_in(&store, "t1").unfolded(), "the first press opens it");

	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert!(!call_in(&store, "t1").unfolded(), "the second press closes it");
}

#[test]
fn a_failure_can_be_folded_away_and_stays_folded() {
	// The other direction of the same defect: a reader who has read the failure
	// and wants the lines back.
	let (mut store, _) = with_call(tool("t1", ToolState::Failed("exit 1".to_owned()), "trace"));
	assert!(call_in(&store, "t1").unfolded());

	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert!(!call_in(&store, "t1").unfolded());
}

#[test]
fn the_readers_answer_survives_the_call_finishing() {
	// The defect: the fold recomputed from the state on every update, so a call
	// unfolded while it ran folds itself when it finishes, and a folded one
	// reopens when it fails. Both read as the window undoing a press.
	for state in states() {
		let (mut store, id) = with_call(tool("t1", ToolState::Running, "output"));
		let opened = call_in(&store, "t1").unfolded();
		Command::ToggleTool("t1".to_owned()).run(&mut store);
		let wanted = !opened;

		if let Some(Block::Tool(call)) = store
			.session_mut(&id)
			.expect("the conversation is there")
			.messages
			.last_mut()
			.and_then(|message| message.blocks.first_mut())
		{
			call.state = state.clone();
		}

		assert_eq!(
			call_in(&store, "t1").unfolded(),
			wanted,
			"moving to {state:?} left the fold where the reader put it"
		);
	}
}

#[test]
fn a_call_in_a_conversation_that_is_not_on_screen_is_not_reachable() {
	// The transcript draws one conversation, so an id from another one is either
	// a stale row or a mistake. Either way the fold is not offered and the move
	// changes nothing.
	let (mut store, _) = with_call(tool("t1", ToolState::Done, "output"));
	moves::new_session(&mut store);
	assert!(store.tool_call("t1").is_none(), "the call is not on screen");
	assert!(!Command::ToggleTool("t1".to_owned()).applies(&store));

	let before = store.clone();
	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert_eq!(store, before, "the move over a call that is not on screen is a no-op");
}

#[test]
fn a_press_on_an_id_nothing_carries_changes_nothing() {
	let (mut store, _) = with_call(tool("t1", ToolState::Done, "output"));
	let before = store.clone();
	Command::ToggleTool("t2".to_owned()).run(&mut store);
	assert_eq!(store, before);
}

#[test]
fn one_press_folds_one_call() {
	// Two calls with one id apart: the move walks every block, so the defect
	// would be a loop that folds whatever it finds first, or all of them.
	let (mut store, id) = with_call(tool("t1", ToolState::Done, "output"));
	if let Some(message) = store
		.session_mut(&id)
		.expect("the conversation is there")
		.messages
		.last_mut()
	{
		message
			.blocks
			.push(Block::Tool(tool("t2", ToolState::Done, "output")));
	}

	Command::ToggleTool("t1".to_owned()).run(&mut store);
	assert!(call_in(&store, "t1").unfolded());
	assert!(!call_in(&store, "t2").unfolded(), "the other call was not touched");
}
