//! The session tree opens from each of its entry points: the chord pressed
//! wherever the keyboard is, the thread header's button and the palette's
//! `/tree` row. It draws in the thread column in place of the transcript and
//! takes the keyboard. It closes on the chord or the button, on its own
//! close, and when the window moves to another session; a tree that held the
//! keyboard hands it to the composer, one that did not leaves it where it is.
//! The palette's `/fork` forks the thread and opens no tree.
//!
//! WHY: the chord and the palette dispatch from outside the thread column,
//! so without the App-level route they reach no column and nothing opens; a
//! slot that keeps its sheet across a session switch browses a session the
//! window no longer shows; a close that drops a focused sheet leaves the
//! window with no keyboard target. What the open sheet draws and sends is
//! the sheet's own suite's; this one reads only that it opened, over which
//! session, and that the column drew it.

mod harness;

use gpui::TestAppContext;

use self::harness::{ROOT, Win, fork, listed, load, opened, seeded, tree, window};

/// Asserts the thread column shows the tree over thread `a`, drawn and
/// holding the keyboard, having asked the host for it once.
fn assert_open_over_a(w: &mut Win<'_>) {
	let sheet = w.sheet().expect("the thread column shows the session tree");
	assert_eq!(w.tree_sent(), vec![load("a")], "opening asks for the tree of `a` once");
	assert!(w.focused(&sheet), "the open tree takes the keyboard");
	w.apply(vec![tree("a")]);
	let texts = w.texts();
	assert!(texts.iter().any(|text| text.contains(ROOT)), "the column draws the tree: {texts:?}");
}

#[gpui::test]
fn the_chord_pressed_in_the_sidebar_opens_the_tree_in_the_thread_column(app: &mut TestAppContext) {
	let mut w = window(app, seeded());
	w.focus_sidebar();
	w.keys("secondary-shift-t");
	assert_open_over_a(&mut w);
}

#[gpui::test]
fn the_header_button_opens_the_tree_and_closes_it_handing_the_keyboard_to_the_composer(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded());
	w.click("thread.tree");
	assert_open_over_a(&mut w);
	w.click("thread.tree");
	assert!(w.sheet().is_none(), "a second press closes the tree");
	let texts = w.texts();
	assert!(!texts.iter().any(|text| text.contains(ROOT)), "the transcript is back: {texts:?}");
	assert!(w.composer_focused(), "the keyboard the tree held returns to the composer");
}

#[gpui::test]
fn the_palette_tree_row_opens_the_tree_and_the_fork_row_forks_without_it(app: &mut TestAppContext) {
	let mut w = window(app, seeded());
	w.pick("/fork", "Fork this thread");
	assert_eq!(w.tree_sent(), vec![fork("a")], "`/fork` forks the open thread");
	assert!(w.sheet().is_none(), "`/fork` opens no tree");
	w.pick("/tree", "Show the session tree");
	assert_open_over_a(&mut w);
}

#[gpui::test]
fn the_chord_closes_a_tree_the_keyboard_left_and_leaves_the_keyboard_where_it_is(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded());
	w.keys("secondary-shift-t");
	assert_open_over_a(&mut w);
	w.focus_sidebar();
	w.keys("secondary-shift-t");
	assert!(w.sheet().is_none(), "the chord closes the open tree from the sidebar");
	assert!(w.sidebar_focused() && !w.composer_focused(), "the sidebar keeps the keyboard");
}

#[gpui::test]
fn moving_to_another_session_closes_the_tree_and_hands_the_keyboard_to_the_composer(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded());
	w.keys("secondary-shift-t");
	assert_open_over_a(&mut w);
	w.apply(vec![opened("b")]);
	assert!(w.sheet().is_none(), "the tree of `a` closes once the window shows `b`");
	assert!(w.composer_focused(), "the keyboard the tree held returns to the composer");
	w.keys("secondary-shift-t");
	let sheet = w
		.sheet()
		.expect("the chord opens the tree of the thread now shown");
	assert_eq!(w.tree_sent(), vec![load("b")]);
	assert!(w.focused(&sheet));
}

#[gpui::test]
fn the_tree_closing_itself_hands_the_keyboard_to_the_composer(app: &mut TestAppContext) {
	let mut w = window(app, seeded());
	w.keys("secondary-shift-t");
	assert_open_over_a(&mut w);
	w.keys("escape");
	assert!(w.sheet().is_none(), "escape while browsing closes the tree");
	assert!(w.composer_focused(), "the keyboard the tree held returns to the composer");
}

#[gpui::test]
fn without_an_open_thread_no_entry_point_opens_a_tree(app: &mut TestAppContext) {
	let mut w = window(app, listed());
	assert!(!w.drawn("thread.tree"), "the header draws no tree button without a thread");
	w.keys("secondary-shift-t");
	assert!(w.sheet().is_none(), "the chord opens nothing without a thread");
	w.pick("/tree", "Show the session tree");
	assert!(w.sheet().is_none(), "the palette row opens nothing without a thread");
	assert_eq!(w.tree_sent(), Vec::new());
}
