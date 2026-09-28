//! A record written beside the conversation, stating no parent, is drawn
//! after the conversation and never in place of it.
//!
//! WHY: `/btw` wrote its question and its answer with no parent stated, and
//! the transcript is read back along the parent chain of the entry that
//! arrived last, so a parentless entry was a line of its own and every word
//! said before it left the column. The sweep appends a parentless record of
//! every `MessageRole`, read from the model at run time, through the reducer
//! the host frames land on, and reads the branch the window lists, the words
//! the frame drew and the parent the window's store holds. An answer restated
//! as it grows keeps the parent its append gave it, and a parent chain that
//! closes a loop is walked once, under a deadline, because a walk that does
//! not end is a window that never paints again.
//!
//! Gap: what each record is labelled is `roles`; whether the host writes the
//! pair to the session file is the host's suite.

use std::{
	io::{self, Write as _},
	sync::mpsc::{self, RecvTimeoutError},
	thread as os,
	time::Duration,
};

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{EntryId, MessageRole, TranscriptEntry};

use super::{
	Thread, chain, entry,
	items::{appended, restated},
	opened, sid, text, thread,
};

/// The exchange every record is written beside: a prompt and its reply.
fn conversation(cx: &mut TestAppContext) -> Thread<'_> {
	thread(
		cx,
		opened(chain(vec![
			("u1", MessageRole::User, vec![text("do it")]),
			("a1", MessageRole::Assistant, vec![text("reading")]),
		])),
	)
}

/// A record of `role` written beside the conversation, stating no parent.
fn beside(id: &str, role: MessageRole, words: &str) -> TranscriptEntry {
	entry(id, None, role, vec![text(words)])
}

/// The parent the window's store holds for `id`, and the roots of the tree.
fn linked(thread: &Thread<'_>, id: &str) -> (Option<String>, Vec<String>) {
	thread.state.read_with(&*thread.cx, |state, _| {
		let tree = &state.store().transcripts[&sid()];
		let parent = tree
			.get(&EntryId::from(id))
			.and_then(|held| held.parent.as_ref())
			.map(|parent| parent.0.clone());
		(
			parent,
			tree
				.root_entries
				.iter()
				.map(|root| root.0.clone())
				.collect(),
		)
	})
}

#[gpui::test]
fn a_record_of_every_role_stating_no_parent_is_drawn_after_the_conversation(
	cx: &mut TestAppContext,
) {
	let mut broke = Vec::new();
	for role in MessageRole::iter() {
		let mut thread = conversation(cx);
		thread.apply(vec![appended(vec![beside("r1", role, "a record")])]);
		let ids = thread.ids();
		let drew = ["do it", "reading", "a record"].map(|words| thread.drew(words));
		let (parent, roots) = linked(&thread, "r1");
		if ids != ["u1", "a1", "r1"]
			|| drew != [true; 3]
			|| parent.as_deref() != Some("a1")
			|| roots != ["u1"]
		{
			broke.push(format!(
				"{role:?} listed {ids:?}, drew {drew:?}, is the child of {parent:?} under roots \
				 {roots:?}"
			));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a record written beside the conversation hid it");
}

#[gpui::test]
fn a_side_answer_restated_as_it_grows_stays_where_it_was_appended(cx: &mut TestAppContext) {
	let mut thread = conversation(cx);
	thread.apply(vec![appended(vec![beside("q", MessageRole::Custom, "which file")])]);
	thread.apply(vec![appended(vec![beside("a", MessageRole::Custom, "")])]);
	assert_eq!(thread.ids(), ["u1", "a1", "q", "a"], "the pair was not listed after the exchange");

	// The producer restates the answer as the provider sends it, the way it
	// first sent it: its content, and no parent.
	for (revision, grown) in (2..).zip(["src", "src/lib", "src/lib.rs"]) {
		let mut answer = beside("a", MessageRole::Custom, grown);
		answer.revision = revision;
		thread.apply(vec![restated(answer)]);
	}

	assert_eq!(thread.ids(), ["u1", "a1", "q", "a"], "the branch moved as the answer grew");
	assert_eq!(
		linked(&thread, "a"),
		(Some("q".to_owned()), vec!["u1".to_owned()]),
		"the restated answer dropped the parent its append gave it"
	);
	for words in ["do it", "reading", "which file"] {
		assert!(thread.drew(words), "`{words}` left the column as the answer grew");
	}
	assert_eq!(thread.drew_times("src/lib.rs"), 1, "the grown answer is not drawn once");
}

#[gpui::test]
fn a_parent_chain_that_closes_a_loop_is_walked_once(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	// Each entry states the other as its parent, which no producer should
	// send and any can. A test that reads what was drawn cannot see a walk
	// that never returns, so a watchdog ends the run at the deadline.
	let (walked, watch) = mpsc::channel::<()>();
	let watchdog = os::spawn(move || {
		if watch.recv_timeout(Duration::from_secs(5)) == Err(RecvTimeoutError::Timeout) {
			// The harness captures `eprintln!` from a spawned thread as well,
			// and an abort drops the capture, so the reason goes to the
			// process's own stderr.
			let reason = "the walk of a parent chain that closes a loop did not end within 5s";
			writeln!(io::stderr(), "{reason}").ok();
			std::process::abort();
		}
	});
	thread.apply(vec![appended(vec![
		entry("a", Some("b"), MessageRole::Assistant, vec![text("first")]),
		entry("b", Some("a"), MessageRole::Assistant, vec![text("second")]),
	])]);
	walked.send(()).expect("the watchdog waits for the walk");
	watchdog
		.join()
		.expect("the watchdog ends once the walk returns");

	assert_eq!(thread.ids(), ["a", "b"], "the loop is not listed once, oldest first");
	assert_eq!(
		["first", "second"].map(|words| thread.drew_times(words)),
		[1, 1],
		"an entry of the loop is not drawn once"
	);
}
