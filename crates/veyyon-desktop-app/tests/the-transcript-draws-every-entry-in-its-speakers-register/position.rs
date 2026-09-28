//! Where the operator was reading is kept across a relaunch, and waits for
//! the entry it names.
//!
//! WHY: the window kept no read position, so a relaunch or a switch back to
//! a session always landed at the live edge. The position names an entry the
//! host reports, and that entry is often not on the branch when the window
//! opens: the host sends the transcript after the store is read, and earlier
//! turns page in afterwards. A position placed only on the frame it is read,
//! or overwritten by the first frame drawn without its entry, is lost.
//!
//! Gap: the debounced write to disk is the `remembered` sweep's; a position
//! whose entry the host never sends stays held for as long as the session is
//! open, which nothing here bounds.

use gpui::TestAppContext;
use veyyon_desktop_model::{MessageRole, Store, TranscriptAnchor, TranscriptStore};

use super::{Thread, chain, opened, sid, snapshot, text, thread, thread_over};

/// `count` prompts, `e0` first, each tall enough that the list scrolls.
fn prompts(count: usize) -> Vec<veyyon_desktop_model::TranscriptEntry> {
	let ids: Vec<String> = (0..count).map(|ix| format!("e{ix}")).collect();
	chain(
		ids.iter()
			.enumerate()
			.map(|(ix, id)| (id.as_str(), MessageRole::User, vec![text(&format!("prompt {ix}"))]))
			.collect(),
	)
}

/// A store whose session `s` was left reading entry `e3`, 6 pixels in.
fn left_at_e3() -> Store {
	let mut store = Store::new();
	store.persisted.transcripts.insert(sid(), TranscriptStore {
		scroll_anchor: Some(TranscriptAnchor { entry_id: "e3".to_owned(), offset_px: 6 }),
		..TranscriptStore::default()
	});
	store
}

fn remembered(thread: &Thread<'_>) -> Option<TranscriptAnchor> {
	thread
		.state
		.read_with(&*thread.cx, |state, _| state.read_position(&sid()).cloned())
}

/// The item at the top of the view and the whole pixels past its top.
fn top(thread: &Thread<'_>) -> (usize, u32) {
	let top = thread
		.transcript
		.read_with(&*thread.cx, |transcript, _| transcript.scroll_top());
	(top.item_ix, f32::from(top.offset_in_item).round() as u32)
}

#[gpui::test]
fn a_remembered_position_is_placed_whether_its_entry_is_sent_before_or_after_the_window_opens(
	cx: &mut TestAppContext,
) {
	for sent_late in [false, true] {
		let first = if sent_late { prompts(2) } else { prompts(60) };
		let mut thread = thread_over(cx, left_at_e3(), opened(first));
		if sent_late {
			assert_eq!(
				remembered(&thread).map(|anchor| anchor.entry_id),
				Some("e3".to_owned()),
				"a position whose entry has not arrived is held, not overwritten by the frame drawn \
				 without it"
			);
			thread.apply(vec![snapshot(2, prompts(60))]);
		}
		assert_eq!(top(&thread), (3, 6), "sent late: {sent_late}");
		assert!(thread.drew("prompt 3"), "the entry it names is on screen (sent late: {sent_late})");
		assert!(!thread.drew("prompt 59"), "the live edge is not (sent late: {sent_late})");
	}
}

#[gpui::test]
fn a_scroll_off_the_live_edge_remembers_the_top_entry_and_a_return_to_it_forgets_it(
	cx: &mut TestAppContext,
) {
	let mut thread = thread(cx, opened(prompts(60)));
	assert_eq!(remembered(&thread), None, "a view at the live edge remembers no position");

	thread.wheel(700.0);
	let (item, offset) = top(&thread);
	let ids = thread.ids();
	assert_eq!(
		remembered(&thread),
		Some(TranscriptAnchor { entry_id: ids[item].clone(), offset_px: offset }),
		"a scroll back remembers the entry at the top of the view and the pixels past it"
	);

	thread.wheel(-100_000.0);
	assert_eq!(
		remembered(&thread),
		None,
		"a return to the live edge forgets the position, so the session comes back at the edge"
	);
}
