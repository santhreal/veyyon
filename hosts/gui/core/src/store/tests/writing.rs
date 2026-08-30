//! WHY THIS SUITE EXISTS.
//! What a reader writes has to survive four moves: into a draft that belongs
//! to one conversation, out of it on a send, into a message that is parsed
//! once, and into a title and a row preview that are cut for a narrow column.
//! A defect in any of them shows as text in the wrong conversation, a fence
//! drawn as prose, or a row printing the same line twice.
//!
//! WHAT IT DOES NOT CATCH. Selection, deletion and the settings moves, which
//! are the parent suite and its sibling.

use super::{
	super::{
		model::{Block, Message, Role, SESSION_TITLE_UNTITLED},
		moves,
	},
	store, type_and_send,
};

#[test]
fn sending_appends_what_was_written_and_nothing_else() {
	let mut store = store();
	store.now_ms = 1_200;
	assert!(type_and_send(&mut store, "  look at input.rs  ").is_some());

	let session = store.selected_session().expect("still selected");
	assert_eq!(session.messages.len(), 1, "one message, and no reply invented beside it");
	assert_eq!(session.messages[0].text(), "look at input.rs", "sent untrimmed");
	assert_eq!(session.messages[0].at_ms, 1_200, "stamped with the store's clock");
	assert_eq!(session.draft, "", "the draft outlived the send");
	assert_eq!(session.caret, 0);
	assert_eq!(session.updated_ms, 1_200);
}

#[test]
fn an_empty_or_blank_draft_sends_nothing() {
	let mut store = store();
	for blank in ["", "   ", "\n\t \n"] {
		assert!(type_and_send(&mut store, blank).is_none(), "{blank:?} became a message");
		assert!(store.selected_session().unwrap().messages.is_empty());
	}
}

#[test]
fn the_first_message_names_the_conversation_and_later_ones_leave_the_name_alone() {
	let mut store = store();
	assert!(type_and_send(&mut store, "why does the caret jump").is_some());
	assert_eq!(store.selected_session().unwrap().title, "why does the caret jump");
	assert!(type_and_send(&mut store, "never mind").is_some());
	assert_eq!(
		store.selected_session().unwrap().title,
		"why does the caret jump",
		"a conversation renamed by its last line changes name while it is read"
	);
}

#[test]
fn a_title_is_cut_at_a_word_and_never_mid_word() {
	let long = "the composer keeps the draft per conversation which is what makes switching cheap \
	            and it goes on well past what any header could show";
	let title = moves::title_from(long);
	assert!(title.chars().count() <= moves::TITLE_MAX, "{title:?} is longer than what is kept");
	assert!(long.starts_with(&title), "{title:?} is not a prefix of what was written");
	assert!(!title.ends_with(' '));
	assert!(long[title.len()..].starts_with(' '), "{title:?} stops in the middle of a word");
}

#[test]
fn a_title_from_a_single_unbroken_run_is_still_bounded() {
	let run = "x".repeat(400);
	let title = moves::title_from(&run);
	assert_eq!(title.chars().count(), moves::TITLE_MAX, "one long word has to be cut somewhere");
}

#[test]
fn a_first_line_that_fits_is_kept_whole_for_the_surfaces_to_shorten() {
	let line = "why does the caret jump when the draft is restored";
	assert_eq!(
		moves::title_from(line),
		line,
		"a line inside the bound is stored whole, so a wide header can show all of it"
	);
}

#[test]
fn a_conversation_is_named_by_what_the_message_says_not_by_its_markers() {
	// The defect: the name was taken from the raw draft, so a message that
	// opened with a heading, a bullet or a quote put those characters in the
	// list, the header and the window's own title. Every marker the parser
	// understands is covered, since the name comes from the parsed prose now
	// and a new block kind either flattens to words or is skipped.
	for (written, expected) in [
		("## what the renderer does", "what the renderer does"),
		("- a bullet first", "a bullet first"),
		("> a quote first", "a quote first"),
		("# heading\n\nand a paragraph", "heading"),
		("**bold** and `code`", "bold and code"),
		("1. an ordered item", "an ordered item"),
	] {
		let mut store = store();
		assert!(type_and_send(&mut store, written).is_some());
		assert_eq!(
			store.selected_session().unwrap().title,
			expected,
			"{written:?} named the conversation with its own markers"
		);
	}
}

#[test]
fn a_message_with_no_prose_at_all_leaves_the_conversation_unnamed() {
	// A fence and nothing else has no words to name anything with, and the
	// fence's own backticks are the worst possible name for a conversation.
	let mut store = store();
	assert!(type_and_send(&mut store, "```rust\nfn main() {}\n```").is_some());
	assert_eq!(store.selected_session().unwrap().title, SESSION_TITLE_UNTITLED);
}

#[test]
fn a_pasted_patch_names_the_conversation_after_the_file_it_touches() {
	let mut store = store();
	let patch = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-old\n+new\n";
	assert!(type_and_send(&mut store, patch).is_some());
	assert_eq!(store.selected_session().unwrap().title, "src/main.rs");
}

#[test]
fn a_draft_belongs_to_its_conversation() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	moves::set_draft(&mut store, "half a thought".to_owned(), 4);
	let second = moves::new_session(&mut store);
	assert_eq!(store.selected_session().unwrap().draft, "", "a new conversation starts empty");

	moves::select(&mut store, &first);
	let session = store.selected_session().unwrap();
	assert_eq!(session.draft, "half a thought", "the draft did not come back");
	assert_eq!(session.caret, 4, "the caret came back at zero, so it has to be re-navigated");

	moves::select(&mut store, &second);
	assert_eq!(store.selected_session().unwrap().draft, "");
}

#[test]
fn a_caret_never_lands_past_the_end_of_its_draft() {
	let mut store = store();
	moves::set_draft(&mut store, "short".to_owned(), 500);
	let session = store.selected_session().unwrap();
	assert_eq!(session.caret, session.draft.len(), "the field would index out of bounds");
}

// ---- what a message is made of ----

#[test]
fn a_message_is_parsed_once_when_it_is_written_and_a_fence_stays_a_fence() {
	// The transcript is redrawn on every frame of every animation, so a message
	// that arrived as text and is still text would be re-parsed sixty times a
	// second to produce the same blocks.
	use crate::text::markdown::{Md, Span};
	let message = Message::written(1, 0, "before\n\n```rust\nfn main() {}\n```\n\nafter");
	assert_eq!(message.blocks, vec![Block::Prose(vec![
		Md::Paragraph(vec![Span::Plain("before".to_owned())]),
		Md::Code { lang: "rust".to_owned(), body: "fn main() {}".to_owned() },
		Md::Paragraph(vec![Span::Plain("after".to_owned())]),
	])]);
	assert_eq!(message.text(), "before\nafter", "the preview reads prose, not code");
	assert_eq!(message.role, Role::Operator);
	assert!(!message.streaming, "what the operator wrote is finished when it is sent");
}

#[test]
fn a_pasted_patch_is_a_patch_rather_than_prose_that_starts_with_a_plus() {
	// The one input where reading it as markdown loses the file it names: every
	// added line starts with `+`, which is a list item.
	let text = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 \
	            +1,2 @@\n-let a = 1;\n+let a = 2;\n unchanged\n";
	let message = Message::written(1, 0, text);
	let Some(Block::Patch(files)) = message.blocks.first() else {
		panic!("a patch was read as {:?}", message.blocks);
	};
	assert_eq!(files.len(), 1);
	assert_eq!(files[0].path(), "src/app.ts");
	assert_eq!((files[0].added(), files[0].removed()), (1, 1));
	assert_eq!(message.text(), "src/app.ts", "a preview names the file, not the hunk");
}

#[test]
fn the_row_preview_is_the_last_thing_said_as_one_line() {
	// A newline inside a paragraph is a space, which is what markdown says and
	// what a one-line row needs: cutting at the newline would show half a
	// sentence and call it the preview.
	let mut store = store();
	assert!(type_and_send(&mut store, "first").is_some());
	assert!(type_and_send(&mut store, "  second line one  \nsecond line two").is_some());
	assert_eq!(
		store.selected_session().unwrap().preview().as_deref(),
		Some("second line one second line two")
	);
}

#[test]
fn a_preview_is_cut_at_a_word_rather_than_carrying_a_whole_paragraph() {
	let mut store = store();
	let long = "word ".repeat(80);
	assert!(type_and_send(&mut store, &long).is_some());
	// The title takes the first line, so the preview only appears once there is
	// a second message with something else in it.
	assert!(type_and_send(&mut store, &format!("other {long}")).is_some());
	let preview = store
		.selected_session()
		.unwrap()
		.preview()
		.expect("a second message");
	assert!(preview.chars().count() <= 140, "a preview of {} characters", preview.chars().count());
	assert!(!preview.ends_with("wor"), "cut mid-word: {preview:?}");
}

#[test]
fn a_conversation_with_only_a_code_block_has_no_preview_rather_than_a_blank_one() {
	let mut store = store();
	assert!(type_and_send(&mut store, "```\nls\n```").is_some());
	assert_eq!(store.selected_session().unwrap().preview(), None);
}

#[test]
fn a_row_does_not_print_the_line_that_named_it_twice() {
	let mut store = store();
	assert!(type_and_send(&mut store, "why does the caret jump when the draft reloads").is_some());
	let session = store.selected_session().unwrap();
	assert_eq!(session.title, "why does the caret jump when the draft reloads");
	assert_eq!(
		session.preview(),
		None,
		"the only message is the title, so the row has nothing else to show"
	);
}

// ---- the list ----

#[test]
fn a_notice_naming_a_conversation_stays_one_short_line_and_says_it_was_cut() {
	// A conversation is named by its own first message, which can be a
	// paragraph, and the notice sits beside the composer for four seconds: the
	// name is cut, what is quoted is the name rather than a count or an id, and
	// the cut carries a mark. Nothing shortens this line downstream, so a cut
	// with no mark reads on screen as a sentence that stopped.
	let mut store = store();
	let long = "turn one: the composer keeps the draft per conversation, which is what makes \
	            switching between them cheap";
	assert!(type_and_send(&mut store, long).is_some());
	let named = store.selected_session().unwrap().title.clone();
	let id = store.selected.clone().unwrap();
	moves::new_session(&mut store);

	moves::delete_session(&mut store, &id);

	let notice = store.notice.clone().expect("deleting says what went");
	assert!(
		notice.starts_with("Deleted turn one:"),
		"the notice does not name what went: {notice:?}"
	);
	assert!(
		notice.chars().count() < named.chars().count(),
		"the notice quotes the whole name: {notice:?}"
	);
	assert!(notice.ends_with('\u{2026}'), "the cut is not marked: {notice:?}");
	assert!(!notice.contains("\u{2026}\u{2026}"), "the cut is marked twice: {notice:?}");
	assert!(notice.chars().count() <= 56, "one line beside a field, at most: {notice:?}");

	// A name that fits is not marked, because nothing was cut from it.
	let short = store.selected.clone().unwrap();
	moves::set_draft(&mut store, "short one".to_owned(), 9);
	assert!(moves::send(&mut store).is_some());
	moves::new_session(&mut store);
	moves::delete_session(&mut store, &short);
	let notice = store.notice.clone().expect("deleting says what went");
	assert_eq!(notice, "Deleted short one");
}
