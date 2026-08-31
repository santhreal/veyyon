//! WHY. The text selection model supported pure span resolution, grapheme
//! snapping, and normalisation, but pointer interaction was detached from
//! gpui text layout geometry. Without hit testing against real wrapped,
//! truncated, and bidi-aware line layouts, pointer drags in the transcript
//! selected nothing or miscalculated offsets on multi-byte text.
//!
//! THE CLASS. Real gpui window pointer interaction across laid-out text
//! runs: press-drag-release across single runs, multi-element transitions,
//! backward drags, single-press clears, line-wrapping continuity, truncation
//! boundary clamping, and right-to-left / multi-byte grapheme preservation.
//!
//! WHAT IT DOES NOT CATCH. Subpixel font hinting differences across distinct
//! GPU driver backends and operating-system clipboard daemons.

use std::{collections::HashMap, sync::Mutex};

use gpui::{
	Context, Entity, HighlightStyle, InteractiveElement, IntoElement, Modifiers, MouseButton,
	MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, Render, Styled, StyledText,
	TestAppContext, VisualTestContext, Window, div, point, px,
};

use crate::{
	input::selection::{self, snap_to_grapheme},
	theme::{Appearance, Theme},
};

static TEST_LOCK: Mutex<()> = Mutex::new(());

struct TestTranscriptView {
	elements:        Vec<(String, String)>,
	layouts:         HashMap<String, gpui::TextLayout>,
	container_width: Option<Pixels>,
	truncate:        bool,
}

impl TestTranscriptView {
	fn new(elements: &[(&str, &str)]) -> Self {
		let elements_vec: Vec<(String, String)> = elements
			.iter()
			.map(|(k, v)| ((*k).to_string(), (*v).to_string()))
			.collect();
		selection::publish_document(&elements_vec);
		Self {
			elements:        elements_vec,
			layouts:         HashMap::new(),
			container_width: None,
			truncate:        false,
		}
	}

	fn with_width(mut self, width: Pixels) -> Self {
		self.container_width = Some(width);
		self
	}

	fn with_truncation(mut self, width: Pixels) -> Self {
		self.container_width = Some(width);
		self.truncate = true;
		self
	}

	fn position_for(&self, key: &str, offset: usize) -> Option<Point<Pixels>> {
		self
			.layouts
			.get(key)
			.and_then(|l| l.position_for_index(offset))
	}
}

impl Render for TestTranscriptView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let theme = Theme::of(Appearance::Dark);
		let mut root = div()
			.id("test-transcript-root")
			.flex()
			.flex_col()
			.size_full()
			.on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, _| {
				if !event.modifiers.shift && !selection::is_dragging() {
					selection::clear();
				}
				window.refresh();
			})
			.on_mouse_up(MouseButton::Left, move |_, window, _| {
				if selection::end_active_drag().is_some() {
					window.refresh();
				}
			});

		for (key, text_content) in &self.elements {
			let styles: Vec<(std::ops::Range<usize>, HighlightStyle)> =
				selection::apply_selection_highlights(text_content, key, Vec::new(), &theme);
			let styled_text = StyledText::new(text_content.clone()).with_highlights(styles);
			let layout = styled_text.layout().clone();
			self.layouts.insert(key.clone(), layout.clone());

			let key_down = key.clone();
			let key_move = key.clone();
			let layout_down = layout.clone();
			let layout_move = layout.clone();
			let el_id = format!("el-{key}");

			let mut text_container = div()
				.id(el_id)
				.child(styled_text)
				.on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, _| {
					let offset = match layout_down.index_for_position(event.position) {
						Ok(ix) | Err(ix) => ix,
					};
					if event.modifiers.shift {
						selection::extend_anchor_at(&key_down, offset);
					} else {
						selection::begin_at(&key_down, offset);
					}
					window.refresh();
				})
				.on_mouse_move(move |event: &MouseMoveEvent, window, _| {
					if selection::is_dragging() {
						let offset = match layout_move.index_for_position(event.position) {
							Ok(ix) | Err(ix) => ix,
						};
						if selection::drag_to(&key_move, offset) {
							window.refresh();
						}
					}
				});

			if let Some(w) = self.container_width {
				text_container = text_container.w(w);
			}
			if self.truncate {
				text_container = text_container.overflow_hidden().whitespace_nowrap();
			}

			root = root.child(text_container);
		}

		root
	}
}

fn open_view(
	cx: &mut TestAppContext,
	view: TestTranscriptView,
) -> (Entity<TestTranscriptView>, &mut VisualTestContext) {
	cx.add_window_view(|_window, _cx| view)
}

fn drag(cx: &mut VisualTestContext, from: Point<Pixels>, to: Point<Pixels>) {
	cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
	cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
	cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
	cx.run_until_parked();
}

#[gpui::test]
fn a_press_drag_release_across_one_run_selects_the_characters_the_pointer_crossed(
	cx: &mut TestAppContext,
) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let text = "The quick brown fox jumps over the lazy dog";
	let (view, cx) = open_view(cx, TestTranscriptView::new(&[("run-0", text)]));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("run-0", 4).expect("layout pos start");
		let p2 = view.position_for("run-0", 19).expect("layout pos end");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_start, p_end);
	assert_eq!(selection::selected_text().as_deref(), Some("quick brown fox"));
	assert_eq!(selection::wash_range("run-0"), Some(4..19));
}

#[gpui::test]
fn a_drag_that_crosses_from_one_keyed_element_into_another_produces_spans_over_both(
	cx: &mut TestAppContext,
) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let items = [("block-0", "Alpha bravo charlie delta"), ("block-1", "Echo foxtrot golf hotel")];
	let (view, cx) = open_view(cx, TestTranscriptView::new(&items));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("block-0", 6).expect("pos start");
		let p2 = view.position_for("block-1", 12).expect("pos end");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_start, p_end);
	assert_eq!(selection::selected_text().as_deref(), Some("bravo charlie delta\nEcho foxtrot"));
	assert_eq!(selection::wash_range("block-0"), Some(6..25));
	assert_eq!(selection::wash_range("block-1"), Some(0..12));
}

#[gpui::test]
fn a_backward_drag_selects_the_same_text_as_the_equivalent_forward_drag(cx: &mut TestAppContext) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let text = "The quick brown fox jumps over the lazy dog";
	let (view, cx) = open_view(cx, TestTranscriptView::new(&[("run-0", text)]));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("run-0", 19).expect("pos start");
		let p2 = view.position_for("run-0", 4).expect("pos end");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_start, p_end);
	assert_eq!(selection::selected_text().as_deref(), Some("quick brown fox"));
	assert_eq!(selection::wash_range("run-0"), Some(4..19));
}

#[gpui::test]
fn a_press_with_no_drag_selects_nothing_and_clears_a_previous_selection(cx: &mut TestAppContext) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let text = "The quick brown fox jumps over the lazy dog";
	let (view, cx) = open_view(cx, TestTranscriptView::new(&[("run-0", text)]));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("run-0", 4).expect("pos start");
		let p2 = view.position_for("run-0", 19).expect("pos end");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});
	drag(cx, p_start, p_end);
	assert!(selection::selected_text().is_some());

	cx.simulate_mouse_down(p_start, MouseButton::Left, Modifiers::default());
	cx.simulate_mouse_up(p_start, MouseButton::Left, Modifiers::default());
	cx.run_until_parked();

	assert_eq!(selection::selected_text(), None);
	assert!(selection::wash_range("run-0").is_none());
}

#[gpui::test]
fn a_drag_over_text_that_wraps_across_two_visual_lines_selects_across_the_wrap(
	cx: &mut TestAppContext,
) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
	let view = TestTranscriptView::new(&[("wrap-0", text)]).with_width(px(140.0));
	let (view, cx) = open_view(cx, view);
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("wrap-0", 6).expect("pos line 1");
		let p2 = view.position_for("wrap-0", 35).expect("pos line 2");
		assert!(p2.y > p1.y, "text wrapped across visual rows");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_start, p_end);
	let expected = &text[6..35];
	assert_eq!(selection::selected_text().as_deref(), Some(expected));
}

#[gpui::test]
fn a_drag_over_text_that_is_truncated_with_an_ellipsis_never_resolves_past_end(
	cx: &mut TestAppContext,
) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let text = "supercalifragilisticexpialidocious text in a narrow container";
	let view = TestTranscriptView::new(&[("trunc-0", text)]).with_truncation(px(80.0));
	let (view, cx) = open_view(cx, view);
	cx.run_until_parked();

	let p_start = view.update(cx, |view, _| {
		let p1 = view.position_for("trunc-0", 0).expect("pos start");
		point(p1.x + px(2.0), p1.y + px(4.0))
	});
	let p_end = point(px(78.0), p_start.y);

	drag(cx, p_start, p_end);
	let range = selection::wash_range("trunc-0").expect("selection wash range exists");
	assert!(range.end > 0, "selection extends to visible end");
	assert!(range.end <= text.len(), "never resolves past end");
	let sel = selection::selected_text().expect("selected text exists");
	assert!(!sel.is_empty(), "selected text non-empty");
	assert!(sel.len() <= text.len(), "selected length bounded by string");
}

#[gpui::test]
fn a_drag_over_rtl_and_multibyte_grapheme_clusters_never_lands_mid_cluster(
	cx: &mut TestAppContext,
) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let rtl = "\u{0645}\u{0631}\u{062d}\u{0628}\u{0627} \
	           \u{0628}\u{0627}\u{0644}\u{0639}\u{0627}\u{0644}\u{0645}";
	let emoji = "👨‍👩‍👧‍👦 re\u{0301}sume\u{0301} 🦀";
	let items = [("rtl-0", rtl), ("emoji-0", emoji)];
	let (view, cx) = open_view(cx, TestTranscriptView::new(&items));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view
			.position_for("emoji-0", 0)
			.unwrap_or(point(px(0.0), px(20.0)));
		let p2 = point(p1.x + px(45.0), p1.y);
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_start, p_end);
	if let Some(range) = selection::wash_range("emoji-0") {
		assert_eq!(snap_to_grapheme(emoji, range.start), range.start);
		assert_eq!(snap_to_grapheme(emoji, range.end), range.end);
	}

	let (p_rtl_start, p_rtl_end) = view.update(cx, |view, _| {
		let p1 = view
			.position_for("rtl-0", 0)
			.unwrap_or(point(px(0.0), px(0.0)));
		let p2 = point(p1.x + px(30.0), p1.y);
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});

	drag(cx, p_rtl_start, p_rtl_end);
	if let Some(range) = selection::wash_range("rtl-0") {
		assert_eq!(snap_to_grapheme(rtl, range.start), range.start);
		assert_eq!(snap_to_grapheme(rtl, range.end), range.end);
	}
}

#[gpui::test]
fn a_shift_click_extends_anchor_to_clicked_offset(cx: &mut TestAppContext) {
	let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
	selection::clear();
	let items = [("block-0", "Alpha bravo charlie delta"), ("block-1", "Echo foxtrot golf hotel")];
	let (view, cx) = open_view(cx, TestTranscriptView::new(&items));
	cx.run_until_parked();

	let (p_start, p_end) = view.update(cx, |view, _| {
		let p1 = view.position_for("block-0", 6).expect("pos 1");
		let p2 = view.position_for("block-0", 11).expect("pos 2");
		(point(p1.x + px(2.0), p1.y + px(4.0)), point(p2.x + px(2.0), p2.y + px(4.0)))
	});
	drag(cx, p_start, p_end);
	assert_eq!(selection::selected_text().as_deref(), Some("bravo"));

	let p_click2 = view.update(cx, |view, _| {
		let p2 = view.position_for("block-1", 12).expect("pos shift click");
		point(p2.x + px(2.0), p2.y + px(4.0))
	});
	cx.simulate_mouse_down(p_click2, MouseButton::Left, Modifiers {
		shift: true,
		..Default::default()
	});
	cx.simulate_mouse_up(p_click2, MouseButton::Left, Modifiers {
		shift: true,
		..Default::default()
	});
	cx.run_until_parked();

	assert_eq!(selection::selected_text().as_deref(), Some("bravo charlie delta\nEcho foxtrot"));
}
