//! Masked editor contracts. A masked editor holds a secret: the frame it
//! shapes contains only mask glyphs, carets, selections and pointer hits map
//! one to one by grapheme between the secret and its mask, the input method
//! reads mask glyphs, and copy and cut leave the clipboard and the text as
//! they were, before and after undo.
//!
//! The secret mixes graphemes of one, two, one and seven chars, so a mask
//! built per char instead of per grapheme, or an offset mapped without the
//! mask, moves a caret off its grapheme. Not covered: a platform input method
//! reading the field; `text_for_range` is called directly.

use std::rc::Rc;

use veyyon_gpui::{
	Bounds, ClipboardItem, Entity, EntityInputHandler, Pixels, TestAppContext, VisualTestContext,
	point, px,
};

use super::{
	Editor, EditorMode, MASK_GLYPH,
	layout::TextLayout,
	mask::Mask,
	view_tests::{open, text},
};

/// `k`, `e` with a combining acute, a CJK ideograph, a ZWJ family, `9`.
const SECRET: &str = "ke\u{0301}\u{4f60}\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}9";
/// Byte offset of every grapheme boundary of [`SECRET`].
const BOUNDARIES: [usize; 6] = [0, 1, 4, 7, 25, 26];
/// UTF-16 length of [`SECRET`].
const SECRET_UTF16: usize = 13;

/// Opens a focused single-line editor holding [`SECRET`], masked.
fn masked(app: &mut TestAppContext) -> (Entity<Editor>, &mut VisualTestContext) {
	let (editor, _events, cx) = open(app, EditorMode::SingleLine);
	editor.update(cx, |editor, cx| {
		editor.set_masked(true, cx);
		editor.set_text(SECRET, cx);
	});
	cx.run_until_parked();
	(editor, cx)
}

/// The layout of the last frame, which must match the editor's current text
/// and mask state.
fn frame(editor: &Entity<Editor>, cx: &VisualTestContext) -> Rc<TextLayout> {
	editor
		.read_with(cx, |editor, _| editor.current_layout())
		.expect("the editor drew a frame of its current text")
}

fn clipboard(cx: &mut VisualTestContext) -> Option<String> {
	cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
}

fn close(a: Pixels, b: f32) -> bool {
	(f32::from(a) - b).abs() < 0.01
}

#[test]
fn a_mask_holds_one_glyph_per_grapheme_and_maps_offsets_both_ways() {
	let mask = Mask::new(SECRET);
	assert_eq!(mask.display().to_string(), "\u{2022}".repeat(5));
	let width = MASK_GLYPH.len_utf8();
	for (index, &offset) in BOUNDARIES.iter().enumerate() {
		assert_eq!(mask.to_display(offset), index * width, "boundary {offset} to display");
		assert_eq!(mask.to_text(index * width), offset, "glyph {index} to text");
	}
	assert_eq!(mask.to_display(2), width, "an offset inside a grapheme snaps to its start");
	assert_eq!(mask.to_text(width + 1), 1, "an offset inside a glyph snaps to its start");
	assert_eq!(Mask::new("a\nb").display().to_string(), "\u{2022}\n\u{2022}", "line breaks stay");
}

#[test]
fn a_masked_frame_shapes_no_character_of_the_secret() {
	let mut app = TestAppContext::single();
	let (editor, cx) = masked(&mut app);
	assert_eq!(text(&editor, cx), SECRET, "the text stays readable to the caller");

	let layout = frame(&editor, cx);
	assert_eq!(layout.lines.len(), 1, "a single-line editor shapes one line");
	let line = layout.lines.first().expect("one shaped line");
	assert_eq!(line.text.to_string(), "\u{2022}".repeat(5));
	for run in &line.unwrapped_layout.runs {
		for glyph in &run.glyphs {
			assert!(line.text[glyph.index..].starts_with(MASK_GLYPH), "glyph at {}", glyph.index);
		}
	}

	editor.update(cx, |editor, cx| editor.set_masked(false, cx));
	cx.run_until_parked();
	let unmasked = frame(&editor, cx);
	let line = unmasked.lines.first().expect("one shaped line");
	assert_eq!(line.text.to_string(), SECRET, "unmasking shows the text");
}

#[test]
fn carets_selections_and_hits_map_one_to_one_by_grapheme() {
	let mut app = TestAppContext::single();
	let (editor, cx) = masked(&mut app);
	let layout = frame(&editor, cx);
	let glyph = f32::from(layout.position(BOUNDARIES[1]).x);
	assert!(glyph > 0.0, "a mask glyph has width");
	for (index, &offset) in BOUNDARIES.iter().enumerate() {
		let x = layout.position(offset).x;
		assert!(close(x, glyph * index as f32), "caret at boundary {index} drawn at {x:?}");
		let hit = point(px(glyph * (index as f32 - 0.25)), Pixels::ZERO);
		assert_eq!(layout.offset_for_position(hit), offset, "a hit just left of caret {index}");
	}

	cx.simulate_keystrokes("left left");
	assert_eq!(editor.read_with(cx, |editor, _| editor.cursor_offset()), BOUNDARIES[3]);
	cx.simulate_keystrokes("shift-left");
	editor.update_in(cx, |editor, window, cx| {
		assert_eq!(editor.buffer().selection().range(), BOUNDARIES[2]..BOUNDARIES[3]);
		let family = editor
			.bounds_for_range(4..12, Bounds::default(), window, cx)
			.expect("a drawn editor has bounds for a range");
		assert!(close(family.origin.x, glyph * 3.0), "family starts at glyph 3");
		assert!(close(family.size.width, glyph), "a seven-char grapheme is one glyph wide");

		let mut adjusted = None;
		let read = editor.text_for_range(0..SECRET_UTF16, &mut adjusted, window, cx);
		assert_eq!(read, Some(MASK_GLYPH.to_string().repeat(SECRET_UTF16)));
		assert_eq!(adjusted, Some(0..SECRET_UTF16), "input method offsets stay in UTF-16 units");
	});
}

#[test]
fn copy_and_cut_leave_the_clipboard_and_the_text_while_masked() {
	let mut app = TestAppContext::single();
	let (editor, cx) = masked(&mut app);
	cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("before".to_owned())));

	cx.simulate_keystrokes("ctrl-a ctrl-c ctrl-x");
	assert_eq!(clipboard(cx).as_deref(), Some("before"));
	assert_eq!(text(&editor, cx), SECRET, "cut removes nothing while masked");

	cx.simulate_keystrokes("backspace ctrl-z ctrl-a ctrl-c");
	assert_eq!(text(&editor, cx), SECRET);
	assert_eq!(clipboard(cx).as_deref(), Some("before"), "undo restores no secret to copy");

	editor.update(cx, |editor, cx| editor.set_masked(false, cx));
	cx.simulate_keystrokes("ctrl-a ctrl-c");
	assert_eq!(clipboard(cx).as_deref(), Some(SECRET), "unmasked copy reaches the clipboard");
}
