//! WHY THIS SUITE EXISTS:
//! The desktop's secret field is the same `Editor` as every other field, so
//! the value an operator pastes into it is a plain string in a buffer that
//! draws itself and answers copy. A field that carries a provider key has to
//! draw a mask and refuse the clipboard (§9.3); nothing in the editor's shape
//! makes that happen, so it is asserted here.
//!
//! THE CLASS THIS CLOSES:
//! A secret leaving a masked field through a route that is not its submit.
//! Three routes exist and all three are covered: the pixels the element draws,
//! the string a caller reads back for display, and the clipboard a copy or a
//! cut writes. The mask keeps the byte length of the value, which is what lets
//! caret and selection offsets map through the shaped line unchanged, so that
//! is asserted over multi-byte text rather than over ASCII alone.
//!
//! WHAT IT DOES NOT CATCH:
//! It does not cover the platform's own screen capture, nor a masked value
//! reaching a log or a crash report, which no assertion in this crate can
//! reach. `Editor::text` still returns the value, because the submit needs it;
//! a caller that draws `text()` instead of `display_text()` is caught by the
//! pixel case here only for the fields this crate draws.

mod common;

use common::{EditorFixture, dispatch_keystroke, headless_context, render_frame};
use parking_lot::MutexGuard;
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{AppContext, ClipboardItem, Entity, HeadlessAppContext, WindowHandle, px, size};

/// The value a masked field holds. Multi-byte on purpose: the mask is one
/// asterisk per byte, so a value whose characters are wider than a byte is
/// where a mask built per character would diverge.
const SECRET: &str = "sk-ünïcode-secret";

/// What the clipboard already held before a copy was attempted, so an
/// unchanged clipboard is distinguishable from an emptied one.
const SENTINEL: &str = "clipboard held this before";

/// Opens a window holding one single-line editor, masked or not, seeded with
/// `text` and left unfocused so no caret enters the frame.
fn window_holding(
	masked: bool,
	text: &str,
) -> (HeadlessAppContext, MutexGuard<'static, ()>, WindowHandle<EditorFixture>, Entity<Editor>) {
	let (mut cx, permit) = headless_context();
	let seed = text.to_owned();
	let mut editor_slot = None;
	let window = cx
		.open_window(size(px(420.0), px(64.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				let mut editor = Editor::new(EditorMode::SingleLine, cx);
				if masked {
					editor = editor.masked();
				}
				editor.buffer_mut().set_text(seed);
				editor
			});
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");
	let editor = editor_slot.expect("the window built its editor");
	render_frame(&mut cx, &window);
	(cx, permit, window, editor)
}

/// The pixels one unfocused single-line editor draws.
fn drawn(masked: bool, text: &str) -> Vec<u8> {
	let (mut cx, _permit, window, _editor) = window_holding(masked, text);
	cx.capture_frame(window.into(), 1.0)
		.expect("the window rasterizes a frame")
		.into_bytes()
}

#[test]
fn a_masked_field_draws_the_mask_and_not_the_value() {
	let masked = drawn(true, SECRET);
	let plain = drawn(false, SECRET);
	let mask = "*".repeat(SECRET.len());
	assert_ne!(
		masked, plain,
		"a masked field does not draw the same pixels as the field holding the value plainly"
	);
	assert_eq!(
		masked,
		drawn(false, &mask),
		"a masked field draws exactly what a field holding its mask draws"
	);
}

#[test]
fn the_mask_keeps_the_byte_length_of_the_value_it_hides() {
	let (mut cx, _permit, _window, editor) = window_holding(true, SECRET);
	let (display, value, empty) = cx.update(|app| {
		let editor = editor.read(app);
		(editor.display_text(), editor.text().to_owned(), editor.is_empty())
	});
	assert_eq!(
		display,
		"*".repeat(SECRET.len()),
		"the mask is one asterisk per byte, so caret offsets map through the shaped line"
	);
	assert_eq!(value, SECRET, "the value is still readable by the submit that sends it");
	assert!(!empty, "a masked field holding a value does not report itself empty");
	assert!(
		!display.contains("secret") && !display.contains("sk-"),
		"no fragment of the value survives into what is drawn: {display}"
	);
}

/// Selects everything, runs `chord`, and reports what the clipboard holds and
/// what the buffer holds afterwards.
fn after_clipboard_chord(masked: bool, chord: &str) -> (Option<String>, String) {
	let (mut cx, _permit, window, editor) = window_holding(masked, SECRET);
	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		editor.read(cx).focus_handle().clone().focus(window, cx);
		cx.write_to_clipboard(ClipboardItem::new_string(SENTINEL.to_owned()));
	})
	.expect("the window takes focus and a seeded clipboard");
	render_frame(&mut cx, &window);
	dispatch_keystroke(&mut cx, &window, "cmd-a");
	dispatch_keystroke(&mut cx, &window, chord);
	cx.update(|app| {
		let held = app.read_from_clipboard().and_then(|item| item.text());
		(held, editor.read(app).text().to_owned())
	})
}

#[test]
fn a_copy_out_of_a_masked_field_writes_nothing_to_the_clipboard() {
	let (clipboard, held) = after_clipboard_chord(true, "cmd-c");
	assert_eq!(
		clipboard.as_deref(),
		Some(SENTINEL),
		"the clipboard still holds what it held: a masked field wrote neither the value nor its mask"
	);
	assert_eq!(held, SECRET, "a copy left the value in the field");
}

#[test]
fn a_cut_out_of_a_masked_field_deletes_without_writing_the_clipboard() {
	let (clipboard, held) = after_clipboard_chord(true, "cmd-x");
	assert_eq!(
		clipboard.as_deref(),
		Some(SENTINEL),
		"a cut out of a masked field writes nothing to the clipboard"
	);
	assert_eq!(held, "", "a cut still deletes what it selected");
}

#[test]
fn an_unmasked_field_still_copies_what_it_holds() {
	let (clipboard, held) = after_clipboard_chord(false, "cmd-c");
	assert_eq!(
		clipboard.as_deref(),
		Some(SECRET),
		"the refusal belongs to masked fields alone: an ordinary field still copies"
	);
	assert_eq!(held, SECRET, "a copy left the value in the field");
}
