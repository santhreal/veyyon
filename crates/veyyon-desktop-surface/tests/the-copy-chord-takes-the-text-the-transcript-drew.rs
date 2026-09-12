//! WHY: a selection that cannot be taken out of the window is a highlight and
//! nothing more. The chords are the only way out -- there is no menu row for a
//! partial selection -- so each one is driven here against the real keymap and
//! the real platform clipboard, with a sentinel in it first so a copy that
//! wrote nothing is told apart from a copy that wrote the right thing.
//!
//! CLASS CLOSED: taking an entry, copying what is held, copying with nothing
//! held, and the two ways a selection is dropped: a dismissal, and a press on
//! the canvas beside the text.
//!
//! GAPS: it asserts the text a chord wrote, not the ground the selection was
//! drawn on. Where a press resolves to is
//! `a-drag-over-the-transcript-selects-the-words-it-crossed`.

use veyyon_gpui::{Point, px};

#[path = "support/text-selection/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared selection helpers")]
mod harness;

use harness::{
	FIRST, SECOND, SENTINEL, along, changed_pixels, clipboard, primary, render_session, run_holding,
	two_paragraphs,
};

#[test]
fn the_entry_chord_takes_the_turn_and_the_copy_chord_puts_it_on_the_clipboard() {
	let copied = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		// The chords resolve on the transcript's own context, which the press
		// that focuses the column brings into scope.
		session
			.click(along(run_holding(&rest, FIRST), 0.1))
			.expect("the press focuses the transcript");
		assert!(
			session
				.keystroke(&primary("a"))
				.expect("the chord dispatches"),
			"the chord that takes an entry is bound in the transcript scope"
		);
		assert!(
			session
				.keystroke(&primary("c"))
				.expect("the chord dispatches"),
			"the chord that copies a selection is bound in the transcript scope"
		);
		clipboard(session)
	});

	assert_eq!(
		copied.as_deref(),
		Some(format!("{FIRST}\n{SECOND}").as_str()),
		"the entry chord takes every span of the turn and the copy chord puts them on the clipboard \
		 over what was there"
	);
}

#[test]
fn the_copy_chord_leaves_the_clipboard_alone_when_nothing_is_selected() {
	let (held, claimed) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		session
			.click(along(run_holding(&rest, FIRST), 0.1))
			.expect("the press focuses the transcript");
		let claimed = session
			.keystroke(&primary("c"))
			.expect("the chord dispatches");
		(clipboard(session), claimed)
	});

	assert_eq!(
		held.as_deref(),
		Some(SENTINEL),
		"a copy with nothing selected wrote an empty string over what the reader had copied"
	);
	assert!(
		!claimed,
		"a copy with nothing selected claimed the chord, so no other binding can have it"
	);
}

#[test]
fn a_dismissal_drops_the_selection_and_the_words_come_back_unselected() {
	let (held, dropped, repainted) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		session
			.drag(along(first, 0.2), along(first, 0.8))
			.expect("the drag stays inside the paragraph");
		let dragged = session.frame().expect("frame renders after the drag");
		let held = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		session.keystroke("escape").expect("Escape dispatches");
		let cleared = session.frame().expect("frame renders after the dismissal");
		let dropped = session
			.update(|view, _window, _cx| view.text_selection().is_none())
			.expect("the view reads back its selection");
		(held, dropped, changed_pixels(&dragged.frame, &cleared.frame, first))
	});

	assert!(
		!held.is_empty(),
		"a drag inside one paragraph selected no words, so what follows proves nothing about \
		 dropping them"
	);
	assert!(dropped, "Escape left the selection held, so the highlight has no way out");
	assert!(
		repainted > 0,
		"the dismissal dropped the selection and repainted nothing, so the highlight is still drawn"
	);
}

#[test]
fn a_press_on_the_canvas_beside_the_text_drops_the_selection() {
	let (held, dropped) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		session
			.drag(along(first, 0.2), along(first, 0.8))
			.expect("the drag stays inside the paragraph");
		let held = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		// The margin left of the column is the transcript's own canvas: a press
		// there names no span, and it is the press that ends a selection without
		// starting another.
		session
			.click(Point { x: first.origin.x - px(24.0), y: along(first, 0.5).y })
			.expect("the press lands beside the text");
		let dropped = session
			.update(|view, _window, _cx| view.text_selection().is_none())
			.expect("the view reads back its selection");
		(held, dropped)
	});

	assert!(
		!held.is_empty(),
		"a drag inside one paragraph selected no words, so what follows proves nothing about \
		 dropping them"
	);
	assert!(
		dropped,
		"a press beside the text left the selection held, so the highlight stays drawn under a \
		 pointer that has moved on"
	);
}
