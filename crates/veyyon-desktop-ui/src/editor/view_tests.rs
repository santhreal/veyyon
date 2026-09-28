//! Editor view contracts driven through a test window: typed input, Enter per
//! mode, history navigation at the first and last row, and input-method
//! composition.

use std::{cell::RefCell, rc::Rc};

use veyyon_gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};

use super::{Editor, EditorEvent, EditorMode};
use crate::theme::{Appearance, Theme};

type Events = Rc<RefCell<Vec<EditorEvent>>>;

/// Opens a focused editor in `mode` and records every event it emits after
/// focus.
pub(super) fn open(
	app: &mut TestAppContext,
	mode: EditorMode,
) -> (Entity<Editor>, Events, &mut VisualTestContext) {
	app.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	let (editor, cx) = app.add_window_view(|window, cx| Editor::new(mode, window, cx));
	let events = Events::default();
	let log = events.clone();
	cx.update(|_, cx| {
		cx.subscribe(&editor, move |_, event: &EditorEvent, _| log.borrow_mut().push(*event))
			.detach();
	});
	editor.update_in(cx, |editor, window, cx| {
		window.activate_window();
		editor.focus(window, cx);
	});
	cx.run_until_parked();
	assert_eq!(events.take(), [EditorEvent::Focused]);
	(editor, events, cx)
}

pub(super) fn text(editor: &Entity<Editor>, cx: &VisualTestContext) -> String {
	editor.read_with(cx, |editor, _| editor.text().to_owned())
}

#[test]
fn typing_updates_the_text_and_reports_each_change() {
	let mut app = TestAppContext::single();
	let (editor, events, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	cx.simulate_input("hi");
	assert_eq!(text(&editor, cx), "hi");
	assert_eq!(events.take(), [EditorEvent::Changed, EditorEvent::Changed]);
	assert_eq!(editor.read_with(cx, |editor, _| editor.cursor_offset()), 2);
}

#[test]
fn enter_submits_when_configured_and_shift_enter_breaks_the_line() {
	let mut app = TestAppContext::single();
	let (editor, events, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	cx.simulate_input("a");
	events.take();
	cx.simulate_keystrokes("enter");
	assert_eq!(text(&editor, cx), "a");
	assert_eq!(events.take(), [EditorEvent::Submit]);
	cx.simulate_keystrokes("shift-enter");
	assert_eq!(text(&editor, cx), "a\n");
	assert_eq!(events.take(), [EditorEvent::Changed]);
}

#[test]
fn enter_breaks_the_line_when_submit_on_enter_is_off() {
	let mut app = TestAppContext::single();
	let (editor, events, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: false });
	cx.simulate_input("a");
	cx.simulate_keystrokes("enter");
	assert_eq!(text(&editor, cx), "a\n");
	assert!(!events.take().contains(&EditorEvent::Submit));
}

#[test]
fn a_single_line_editor_submits_on_enter_and_shift_enter() {
	let mut app = TestAppContext::single();
	let (editor, events, cx) = open(&mut app, EditorMode::SingleLine);
	cx.simulate_input("a");
	events.take();
	cx.simulate_keystrokes("enter shift-enter");
	assert_eq!(text(&editor, cx), "a");
	assert_eq!(events.take(), [EditorEvent::Submit, EditorEvent::Submit]);
}

#[test]
fn up_on_the_first_row_and_down_on_the_last_navigate_history() {
	let mut app = TestAppContext::single();
	let (editor, events, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	cx.simulate_input("a");
	cx.simulate_keystrokes("shift-enter");
	cx.simulate_input("b");
	events.take();
	let line = |cx: &VisualTestContext| {
		editor.read_with(cx, |editor, _| editor.buffer().line_column(editor.cursor_offset()).0)
	};

	cx.simulate_keystrokes("up");
	assert_eq!(line(cx), 0, "up from the second row moves the caret");
	assert!(events.take().is_empty());
	cx.simulate_keystrokes("up");
	assert_eq!(events.take(), [EditorEvent::HistoryPrev]);

	cx.simulate_keystrokes("down");
	assert_eq!(line(cx), 1, "down from the first row moves the caret");
	assert!(events.take().is_empty());
	cx.simulate_keystrokes("down");
	assert_eq!(events.take(), [EditorEvent::HistoryNext]);
	assert_eq!(text(&editor, cx), "a\nb");
}

#[test]
fn committed_composition_replaces_the_marked_text() {
	let mut app = TestAppContext::single();
	let (editor, _events, cx) = open(&mut app, EditorMode::MultiLine { submit_on_enter: true });
	cx.simulate_input("a");
	editor.update_in(cx, |editor, window, cx| {
		editor.replace_and_mark_text_in_range(None, "n", Some(1..1), window, cx);
		editor.replace_and_mark_text_in_range(None, "ni", Some(2..2), window, cx);
		assert_eq!(editor.marked_text_range(window, cx), Some(1..3));
		assert_eq!(editor.text(), "ani");
		editor.replace_text_in_range(None, "\u{4f60}", window, cx);
		assert_eq!(editor.marked_text_range(window, cx), None);
	});
	assert_eq!(text(&editor, cx), "a\u{4f60}");
	assert_eq!(editor.read_with(cx, |editor, _| editor.cursor_offset()), 1 + "\u{4f60}".len());

	cx.simulate_keystrokes("ctrl-z");
	assert_eq!(text(&editor, cx), "a", "the composition undoes as one step");
}
