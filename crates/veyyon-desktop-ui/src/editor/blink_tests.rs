//! A focused editor blinks its caret, holds it solid after [`BLINK_PHASES`]
//! phases without input and stops asking for frames, and blinks again on the
//! next edit or motion. A blurred editor asks for nothing.
//!
//! WHY: a caret timer that runs for as long as the editor holds focus
//! notifies the view every 530 ms, and a window with its composer focused
//! then draws two frames a second with nothing changing. The suite counts the
//! editor's notifications on the executor's clock.
//!
//! Gap: the caret's paint is not read; `caret_visible` is the state the
//! element paints from.

use std::{cell::Cell, rc::Rc, time::Duration};

use veyyon_gpui::{Entity, TestAppContext, VisualTestContext};

use super::{BLINK_INTERVAL, BLINK_PHASES, Editor, EditorMode, view_tests::open};

/// Counts the editor's notifications from now on.
fn notifications(editor: &Entity<Editor>, cx: &mut VisualTestContext) -> Rc<Cell<usize>> {
	let count = Rc::new(Cell::new(0));
	let counted = count.clone();
	cx.update(|_, cx| {
		cx.observe(editor, move |_, _| counted.set(counted.get() + 1))
			.detach();
	});
	count
}

/// Moves the clock `phases` blink intervals forward, one at a time.
fn phases(cx: &VisualTestContext, phases: u32) {
	for _ in 0..phases {
		cx.executor().advance_clock(BLINK_INTERVAL);
		cx.run_until_parked();
	}
}

fn caret(editor: &Entity<Editor>, cx: &VisualTestContext) -> bool {
	editor.read_with(cx, |editor, _| editor.caret_visible)
}

#[test]
fn a_focused_caret_blinks_then_holds_solid_and_stops_notifying() {
	let mut app = TestAppContext::single();
	let (editor, _, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	let count = notifications(&editor, cx);
	assert!(caret(&editor, cx), "focus shows the caret");

	phases(cx, 1);
	assert!(!caret(&editor, cx), "the first phase hides it");
	assert_eq!(count.get(), 1);

	phases(cx, BLINK_PHASES - 1);
	assert!(caret(&editor, cx), "the caret holds solid once it stops");
	let stopped = count.get();
	let toggles = usize::try_from(BLINK_PHASES - 1).expect("a phase count fits a usize");
	assert_eq!(stopped, toggles, "it toggled on every phase before the last");

	cx.executor().advance_clock(Duration::from_mins(10));
	cx.run_until_parked();
	assert_eq!(count.get(), stopped, "an idle caret asks for no frame");
	assert!(caret(&editor, cx));
}

#[test]
fn input_after_the_caret_stopped_blinks_it_again() {
	let mut app = TestAppContext::single();
	let (editor, _, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	phases(cx, BLINK_PHASES);
	let count = notifications(&editor, cx);

	cx.simulate_input("a");
	let typed = count.get();
	assert!(caret(&editor, cx));

	phases(cx, 1);
	assert!(caret(&editor, cx), "the phase after input holds the caret solid");
	phases(cx, 1);
	assert!(!caret(&editor, cx), "the next phase blinks it");
	assert!(count.get() > typed);

	phases(cx, BLINK_PHASES);
	let stopped = count.get();
	cx.executor().advance_clock(Duration::from_mins(10));
	cx.run_until_parked();
	assert_eq!(count.get(), stopped, "it stops again after the input");
}

#[test]
fn typing_keeps_the_caret_solid_and_the_timer_running() {
	let mut app = TestAppContext::single();
	let (editor, _, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	for _ in 0..2 * BLINK_PHASES {
		cx.simulate_input("a");
		phases(cx, 1);
		assert!(caret(&editor, cx), "a phase after input never hides the caret");
	}
	phases(cx, 1);
	assert!(!caret(&editor, cx), "the timer outlived the typing and blinks");
}

#[test]
fn a_blurred_editor_asks_for_no_frames() {
	let mut app = TestAppContext::single();
	let (editor, _, cx) = open(&mut app, EditorMode::SingleLine);
	cx.update(|window, cx| window.blur(cx));
	cx.run_until_parked();
	let count = notifications(&editor, cx);
	phases(cx, 3 * BLINK_PHASES);
	assert_eq!(count.get(), 0);
	assert!(!caret(&editor, cx));
}
