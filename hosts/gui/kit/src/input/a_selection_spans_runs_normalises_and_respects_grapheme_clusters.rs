//! WHY. A transcript without text selection cannot be copied out of, and an
//! ad-hoc character-width approximation splits multi-byte graphemes, wraps
//! lines unpredictably, and breaks backwards drags.
//!
//! THE CLASS. Run-anchored text selection over virtualized document elements,
//! maintaining normalization, grapheme cluster integrity, word/line boundary
//! snapping, and exact span resolution across element boundaries.
//!
//! WHAT IT DOES NOT CATCH. Window-level GPU compositing and platform-specific
//! clipboard daemon synchronisation.

use gpui::{Bounds, Pixels, Point, point, px, size};

use super::selection::{
	Position, Selection, hit_test_advance, line_range, range_rects_with_positions, resolve_spans,
	snap_to_grapheme, word_range,
};

#[test]
fn normalisation_reverses_backward_drags() {
	let elements = [("run-0", "First paragraph."), ("run-1", "Second paragraph.")];
	let mut sel = Selection::new();

	// Forward drag
	sel.begin("run-0", 6, elements[0].1);
	sel.update_drag(&elements, (1, 6));
	let (start, end) = sel.normalize(&elements).expect("normalizes forward");
	assert_eq!(start, Position::new("run-0", 6));
	assert_eq!(end, Position::new("run-1", 6));
	assert_eq!(sel.selected_text().as_deref(), Some("paragraph.\nSecond"));

	// Backward drag
	sel.begin("run-1", 6, elements[1].1);
	sel.update_drag(&elements, (0, 6));
	let (start, end) = sel.normalize(&elements).expect("normalizes backward");
	assert_eq!(start, Position::new("run-0", 6));
	assert_eq!(end, Position::new("run-1", 6));
	assert_eq!(sel.selected_text().as_deref(), Some("paragraph.\nSecond"));
}

#[test]
fn empty_selection_copies_nothing() {
	let elements = [("run-0", "Hello world")];
	let mut sel = Selection::new();
	assert_eq!(sel.selected_text(), None);

	sel.begin("run-0", 5, elements[0].1);
	assert!(sel.is_empty());
	assert_eq!(sel.selected_text(), None);

	sel.begin_with_span("run-0", elements[0].1, 5..5);
	assert!(sel.is_empty());
	assert_eq!(sel.selected_text(), None);
}

#[test]
fn selection_wholly_inside_one_run() {
	let elements = [("run-0", "The quick brown fox jumps over the lazy dog")];
	let mut sel = Selection::new();
	sel.begin("run-0", 4, elements[0].1);
	sel.update_drag(&elements, (0, 19));

	assert_eq!(sel.selected_text().as_deref(), Some("quick brown fox"));
	assert_eq!(sel.wash_range("run-0"), Some(4..19));
}

#[test]
fn selection_spanning_two_blocks() {
	let elements = [("block-0", "Alpha bravo charlie"), ("block-1", "Delta echo foxtrot")];
	let spans = resolve_spans(&elements, (0, 6), (1, 10));
	assert_eq!(spans.len(), 2);
	assert_eq!(spans[0].key, "block-0");
	assert_eq!(spans[0].range, 6..19);
	assert_eq!(&spans[0].text[spans[0].range.clone()], "bravo charlie");
	assert_eq!(spans[1].key, "block-1");
	assert_eq!(spans[1].range, 0..10);
	assert_eq!(&spans[1].text[spans[1].range.clone()], "Delta echo");
}

#[test]
fn selection_spanning_entry_boundary() {
	let elements = [
		("entry-1-p", "User query here"),
		("entry-2-code", "fn execute() -> bool {\n    true\n}"),
		("entry-2-p", "Assistant reply follows"),
	];
	let spans = resolve_spans(&elements, (0, 5), (2, 9));
	assert_eq!(spans.len(), 3);
	assert_eq!(&spans[0].text[spans[0].range.clone()], "query here");
	assert_eq!(&spans[1].text[spans[1].range.clone()], "fn execute() -> bool {\n    true\n}");
	assert_eq!(&spans[2].text[spans[2].range.clone()], "Assistant");

	let mut sel = Selection::new();
	sel.begin("entry-1-p", 5, elements[0].1);
	sel.update_drag(&elements, (2, 9));
	assert_eq!(
		sel.selected_text().as_deref(),
		Some("query here\nfn execute() -> bool {\n    true\n}\nAssistant")
	);
}

#[test]
fn grapheme_cluster_never_split() {
	// "🦀" is 4 bytes: 0xF0, 0x9F, 0xA6, 0x80
	let text = "a🦀b";
	assert_eq!(text.len(), 6);
	assert_eq!(snap_to_grapheme(text, 0), 0);
	assert_eq!(snap_to_grapheme(text, 1), 1); // before crab
	assert_eq!(snap_to_grapheme(text, 2), 1); // snapped to start of crab
	assert_eq!(snap_to_grapheme(text, 3), 5); // snapped to end of crab
	assert_eq!(snap_to_grapheme(text, 4), 5); // snapped to end of crab
	assert_eq!(snap_to_grapheme(text, 5), 5); // after crab
	assert_eq!(snap_to_grapheme(text, 6), 6);

	// Combining grapheme cluster: 'e' + '\u{0301}' (é)
	let accent = "re\u{0301}sume\u{0301}";
	let snapped = snap_to_grapheme(accent, 2);
	assert!(snapped == 1 || snapped == 4);
}

#[test]
fn shift_extend_anchor_moves_head_keeping_anchor() {
	let elements = [("item-0", "Zero item"), ("item-1", "First item"), ("item-2", "Second item")];
	let mut sel = Selection::new();
	sel.begin("item-1", 6, elements[1].1);
	assert_eq!(sel.anchor(), Some(&Position::new("item-1", 6)));

	// Shift-click extend to item-2
	sel.extend_anchor("item-2", 6, &elements);
	assert_eq!(sel.anchor(), Some(&Position::new("item-1", 6)));
	assert_eq!(sel.head(), Some(&Position::new("item-2", 6)));
	assert_eq!(sel.selected_text().as_deref(), Some("item\nSecond"));

	// Shift-click extend backwards to item-0
	sel.extend_anchor("item-0", 0, &elements);
	assert_eq!(sel.anchor(), Some(&Position::new("item-1", 6)));
	assert_eq!(sel.head(), Some(&Position::new("item-0", 0)));
	assert_eq!(sel.selected_text().as_deref(), Some("Zero item\nFirst "));
}

#[test]
fn word_and_line_boundaries() {
	let text = "hello_world 12345 special\nsecond line here";
	let w = word_range(text, 3);
	assert_eq!(&text[w], "hello_world");

	let w2 = word_range(text, 14);
	assert_eq!(&text[w2], "12345");

	let l = line_range(text, 5);
	assert_eq!(&text[l], "hello_world 12345 special");

	let l2 = line_range(text, 30);
	assert_eq!(&text[l2], "second line here");
}

#[test]
fn hit_test_with_measured_advances() {
	let text = "abc";
	let advances = [10.0, 22.0, 35.0];
	assert_eq!(hit_test_advance(text, &advances, 0.0), 0);
	assert_eq!(hit_test_advance(text, &advances, 4.0), 0);
	assert_eq!(hit_test_advance(text, &advances, 8.0), 1);
	assert_eq!(hit_test_advance(text, &advances, 14.0), 1);
	assert_eq!(hit_test_advance(text, &advances, 20.0), 2);
	assert_eq!(hit_test_advance(text, &advances, 30.0), 3);
	assert_eq!(hit_test_advance(text, &advances, 40.0), 3);
}

#[test]
fn wrapped_line_visual_end_mapping() {
	let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(200.0), px(100.0)));
	let line_height = px(20.0);
	let range = 0..20;

	// Mock position mapping simulating wrapped rows at y=0 and y=20
	let position_for_index = |ix: usize| -> Option<Point<Pixels>> {
		if ix < 10 {
			Some(point(px(ix as f32 * 10.0), px(0.0)))
		} else if ix <= 20 {
			Some(point(px((ix - 10) as f32 * 10.0), px(20.0)))
		} else {
			None
		}
	};

	let rects = range_rects_with_positions(bounds, line_height, &range, position_for_index);
	assert_eq!(rects.len(), 2);
	assert_eq!(rects[0].origin.y, px(0.0));
	assert_eq!(rects[1].origin.y, px(20.0));
}
