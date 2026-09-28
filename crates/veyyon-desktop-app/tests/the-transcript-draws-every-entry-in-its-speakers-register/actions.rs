//! Retry and Rephrase are offered under the reply that ended a finished
//! conversation, and under no other item.
//!
//! WHY: the host retries and rephrases only the last reply, so a button drawn
//! under an earlier reply, under a prompt, under a file the prompt named or
//! while a turn runs sends an action the host applies to a reply the pointer
//! was not on. The sweep ends a finished two-turn chain with a record of
//! every `MessageRole`, read from the model at run time, hovers every item
//! and reads the driver targets its hover row laid out. `ends_with_a_reply`
//! matches with no wildcard, so a role added to the model does not compile
//! here until it states whether a record of it is a reply.
//!
//! Gap: what the host does with the action it is sent is the host's suite.

use gpui::{Modifiers, TestAppContext};
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	EntryId, HostEvent, MessageRole, StreamingMessageState, TranscriptEntry,
};

use super::{
	Thread, chain, entry,
	items::{laid_out, redrawn},
	opened, text, thread,
};

/// Whether a record of `role` that ends the conversation is a reply the
/// host can retry: the operator's prompt and a file it named are not.
const fn ends_with_a_reply(role: MessageRole) -> bool {
	match role {
		MessageRole::User | MessageRole::FileMention => false,
		MessageRole::Developer
		| MessageRole::Assistant
		| MessageRole::ToolResult
		| MessageRole::BashExecution
		| MessageRole::PythonExecution
		| MessageRole::Custom
		| MessageRole::BranchSummary
		| MessageRole::CompactionSummary
		| MessageRole::Lifecycle
		| MessageRole::Unknown => true,
	}
}

/// The ids of every item whose hover row lays out Retry or Rephrase, each
/// read with the pointer over that item.
pub fn offered(thread: &mut Thread<'_>) -> Vec<String> {
	let mut offered = Vec::new();
	for id in thread.ids() {
		let Some(item) = laid_out(thread, &format!("transcript.entry:{id}")) else {
			continue;
		};
		thread
			.cx
			.simulate_mouse_move(item.center(), None, Modifiers::none());
		thread.cx.run_until_parked();
		redrawn(thread);
		let retry = laid_out(thread, &format!("transcript.retry:{id}")).is_some();
		let rephrase = laid_out(thread, &format!("transcript.rephrase:{id}")).is_some();
		if retry || rephrase {
			offered.push(format!("{id}: retry {retry}, rephrase {rephrase}"));
		}
	}
	offered
}

/// A finished two-turn chain whose last record is of `role`.
fn finished(role: MessageRole) -> Vec<TranscriptEntry> {
	chain(vec![
		("u1", MessageRole::User, vec![text("first prompt")]),
		("a1", MessageRole::Assistant, vec![text("first reply")]),
		("u2", MessageRole::User, vec![text("second prompt")]),
		("last", role, vec![text("the last record")]),
	])
}

#[gpui::test]
fn only_the_reply_that_ended_the_conversation_offers_retry_and_rephrase(cx: &mut TestAppContext) {
	let mut broke = Vec::new();
	for role in MessageRole::iter() {
		let mut thread = thread(cx, opened(finished(role)));
		let expected = if ends_with_a_reply(role) {
			vec!["last: retry true, rephrase true".to_owned()]
		} else {
			Vec::new()
		};
		let offered = offered(&mut thread);
		if offered != expected {
			broke.push(format!("ending with {role:?} offered {offered:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "Retry or Rephrase is offered under the wrong item");
}

#[gpui::test]
fn a_running_turn_offers_retry_and_rephrase_nowhere_until_it_ends(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(finished(MessageRole::Assistant)));
	thread.apply(vec![HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry:        EntryId::from("stream-1"),
		tool:         None,
		accumulating: entry("stream-1", None, MessageRole::Assistant, vec![text("partial")]),
		revision:     2,
	}))]);
	assert_eq!(
		offered(&mut thread),
		Vec::<String>::new(),
		"a running turn offers Retry or Rephrase"
	);

	thread.apply(vec![HostEvent::StreamingChanged(None)]);
	assert_eq!(
		offered(&mut thread),
		["last: retry true, rephrase true"],
		"the finished turn does not offer Retry and Rephrase under its reply again"
	);
}
