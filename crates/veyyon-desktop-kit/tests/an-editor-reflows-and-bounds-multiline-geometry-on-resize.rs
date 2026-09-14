//! Verification suite for Editor multiline text reflow on viewport and parent
//! resize, hit-testing/IME consistency across resizes, and resting height
//! geometry (§8.25).
//!
//! WHY: When the viewport or parent container width changes, wrapped text
//! reflows into a different number of visual lines. The editor must re-measure,
//! recompute scroll offsets to keep the caret visible, and ensure mouse
//! hit-testing and IME candidate bounds match the reflowed geometry.
//! Furthermore, `SingleLine` and short multiline drafts must maintain their
//! natural content height rather than inflating to fill parent containers.
//! GAP: Does not test live window manager resize events from X11/Wayland
//! servers.

mod common;
use std::sync::Arc;

use common::*;
use parking_lot::Mutex;
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{
	AppContext, Bounds, Context, Entity, EntityInputHandler, InteractiveElement, IntoElement,
	ParentElement, Pixels, Point, Render, Styled, Window, canvas, div, point, px, size,
};

struct EditorWithSiblingFixture {
	editor:         Entity<Editor>,
	sibling_bounds: Arc<Mutex<Option<Bounds<Pixels>>>>,
}

impl Render for EditorWithSiblingFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let sibling_bounds = self.sibling_bounds.clone();
		div()
			.id("container")
			.flex()
			.flex_col()
			.size_full()
			.child(self.editor.clone())
			.child(
				canvas(
					move |bounds, _window, _cx| {
						*sibling_bounds.lock() = Some(bounds);
					},
					|_, (), _, _| {},
				)
				.w_full()
				.h(px(40.0)),
			)
	}
}
struct DynamicContainer {
	editor: Entity<Editor>,
	width:  Pixels,
	height: Pixels,
}

impl Render for DynamicContainer {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.id("dynamic-container")
			.w(self.width)
			.max_h(self.height)
			.overflow_hidden()
			.child(self.editor.clone())
	}
}

#[test]
fn dynamic_parent_resize_reflows_wrapped_text_and_adjusts_caret_and_geometry() {
	let (mut cx, _permit) = headless_context();
	let window_size = size(px(500.0), px(400.0));
	let initial_w = px(400.0);
	let viewport_h = px(104.0); // 4 lines * 26px

	let mut container_slot = None;
	let mut editor_slot = None;

	let window = cx
		.open_window(window_size, |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx).max_visible_lines(4)
			});
			editor_slot = Some(editor.clone());
			let container =
				app.new(|_cx| DynamicContainer { editor, width: initial_w, height: viewport_h });
			container_slot = Some(container.clone());
			container
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();
	let container = container_slot.unwrap();

	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		editor.read(cx).focus_handle().clone().focus(window, cx);
	})
	.unwrap();

	// 12 words paragraph: in 400px width it fits in 2 lines (<104px viewport).
	let long_paragraph = (1..=12)
		.map(|i| format!("word{i:02} reflow"))
		.collect::<Vec<_>>()
		.join(" ");
	let total_len = long_paragraph.len();
	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(long_paragraph, cx));
	});
	render_frame(&mut cx, &window);

	let viewport_400 = Bounds::new(point(px(0.0), px(0.0)), size(initial_w, viewport_h));
	let caret_bounds_400 = get_caret_bounds(&mut cx, &window, &editor, viewport_400);
	assert!(
		caret_bounds_400.top() >= viewport_400.top()
			&& caret_bounds_400.bottom() <= viewport_400.bottom(),
		"Caret in 400px container at {caret_bounds_400:?} must be within viewport [{:?}, {:?}]",
		viewport_400.top(),
		viewport_400.bottom()
	);

	// Shrink parent container to 120px width: text wraps into ~6 lines (>104px
	// viewport).
	let narrow_w = px(120.0);
	cx.update(|app| {
		container.update(app, |c, cx| {
			c.width = narrow_w;
			cx.notify();
		});
	});
	render_frame(&mut cx, &window);

	let viewport_narrow = Bounds::new(point(px(0.0), px(0.0)), size(narrow_w, viewport_h));
	let caret_bounds_narrow = get_caret_bounds(&mut cx, &window, &editor, viewport_narrow);
	assert!(
		caret_bounds_narrow.top() >= viewport_narrow.top()
			&& caret_bounds_narrow.bottom() <= viewport_narrow.bottom() + px(1.0),
		"Caret in 120px narrowed container at {caret_bounds_narrow:?} must remain visible in [{:?}, \
		 {:?}]",
		viewport_narrow.top(),
		viewport_narrow.bottom()
	);

	// First line should be scrolled up above viewport in the narrowed container
	let line1_bounds = get_range_bounds(&mut cx, &window, &editor, 0..6, viewport_narrow);
	assert!(
		line1_bounds.bottom() <= viewport_narrow.top() + px(1.0),
		"Line 1 ({line1_bounds:?}) must be scrolled above viewport top ({:?})",
		viewport_narrow.top()
	);

	// Verify hit test and IME bounds on last word in narrowed container
	let last_word_start = total_len - 8;
	let ime_bounds =
		get_range_bounds(&mut cx, &window, &editor, last_word_start..total_len, viewport_narrow);
	assert!(
		ime_bounds.top() >= viewport_narrow.top()
			&& ime_bounds.bottom() <= viewport_narrow.bottom() + px(1.0),
		"IME bounds in narrowed container {ime_bounds:?} must be visible in viewport",
	);

	let hit_point: Point<Pixels> = point(ime_bounds.left() + px(5.0), ime_bounds.center().y);
	let hit_idx = cx
		.update_window(window.into(), |_, window, cx| {
			editor.update(cx, |ed, cx| ed.character_index_for_point(hit_point, window, cx).unwrap())
		})
		.unwrap();
	assert!(
		hit_idx >= last_word_start && hit_idx <= total_len,
		"Hit index {hit_idx} must fall in last word range [{last_word_start}..{total_len}]"
	);

	// Expand container back to 400px width: text unwraps to ~2 lines (<104px
	// viewport).
	cx.update(|app| {
		container.update(app, |c, cx| {
			c.width = initial_w;
			cx.notify();
		});
	});
	render_frame(&mut cx, &window);

	let line1_bounds_expanded = get_range_bounds(&mut cx, &window, &editor, 0..6, viewport_400);
	assert_eq!(
		line1_bounds_expanded.top(),
		viewport_400.top(),
		"Line 1 must return to top of viewport after expanding container",
	);

	let caret_bounds_expanded = get_caret_bounds(&mut cx, &window, &editor, viewport_400);
	assert!(
		caret_bounds_expanded.top() >= viewport_400.top()
			&& caret_bounds_expanded.bottom() <= viewport_400.bottom(),
		"Caret must be visible in viewport after expanding container",
	);

	// Verify hit test and IME bounds on last word in expanded container
	let ime_bounds_expanded =
		get_range_bounds(&mut cx, &window, &editor, last_word_start..total_len, viewport_400);
	assert!(
		ime_bounds_expanded.top() >= viewport_400.top()
			&& ime_bounds_expanded.bottom() <= viewport_400.bottom(),
		"IME bounds in expanded container {ime_bounds_expanded:?} must be within viewport",
	);

	let hit_point_expanded: Point<Pixels> =
		point(ime_bounds_expanded.left() + px(5.0), ime_bounds_expanded.center().y);
	let hit_idx_expanded = cx
		.update_window(window.into(), |_, window, cx| {
			editor.update(cx, |ed, cx| {
				ed.character_index_for_point(hit_point_expanded, window, cx)
					.unwrap()
			})
		})
		.unwrap();
	assert!(
		hit_idx_expanded >= last_word_start && hit_idx_expanded <= total_len,
		"Hit index {hit_idx_expanded} after expand must fall in last word range \
		 [{last_word_start}..{total_len}]"
	);
}

#[test]
fn single_line_and_multiline_resting_height_do_not_inflate_layout_geometry() {
	let (mut cx, _permit) = headless_context();
	let window_size = size(px(400.0), px(300.0));
	let line_h = px(26.0); // Standard CosmicTextSystem line height

	// 1. SingleLine editor inside large 300px tall window with trailing sibling
	let mut single_editor_slot = None;
	let single_sibling_bounds = Arc::new(Mutex::new(None));
	let single_window = cx
		.open_window(window_size, |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| Editor::new(EditorMode::SingleLine, cx));
			single_editor_slot = Some(editor.clone());
			app.new(|_cx| EditorWithSiblingFixture {
				editor,
				sibling_bounds: single_sibling_bounds.clone(),
			})
		})
		.expect("single-line window must open");

	let single_editor = single_editor_slot.unwrap();
	cx.update(|app| {
		single_editor.update(app, |ed, cx| ed.set_text("Single line content", cx));
	});
	render_frame(&mut cx, &single_window);

	let single_pos = single_sibling_bounds.lock().unwrap();
	assert!(
		single_pos.top() <= line_h + px(2.0),
		"SingleLine editor must not inflate layout or push sibling down (sibling at {single_pos:?}, \
		 expected top <= {:?})",
		line_h + px(2.0),
	);

	// 2. Multiline editor with 1-line draft inside 300px tall window with trailing
	//    sibling
	let mut multi_editor_slot = None;
	let multi_sibling_bounds = Arc::new(Mutex::new(None));
	let multi_window = cx
		.open_window(window_size, |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx).max_visible_lines(8)
			});
			multi_editor_slot = Some(editor.clone());
			app.new(|_cx| EditorWithSiblingFixture {
				editor,
				sibling_bounds: multi_sibling_bounds.clone(),
			})
		})
		.expect("multiline window must open");

	let multi_editor = multi_editor_slot.unwrap();
	cx.update(|app| {
		multi_editor.update(app, |ed, cx| ed.set_text("Short single line draft", cx));
	});
	render_frame(&mut cx, &multi_window);

	let rest_pos = multi_sibling_bounds.lock().unwrap();
	assert!(
		rest_pos.top() <= line_h + px(2.0),
		"Short draft multiline editor resting height must not inflate layout (sibling at \
		 {rest_pos:?}, expected top <= {:?})",
		line_h + px(2.0),
	);

	// 3. Grow multiline to 3 lines
	cx.update(|app| {
		multi_editor.update(app, |ed, cx| ed.set_text("Line 1\nLine 2\nLine 3", cx));
	});
	render_frame(&mut cx, &multi_window);

	let three_lines_pos = multi_sibling_bounds.lock().unwrap();
	assert!(
		three_lines_pos.top() >= line_h * 3.0 - px(2.0)
			&& three_lines_pos.top() <= line_h * 3.0 + px(2.0),
		"3-line draft multiline editor must position sibling at 3 lines height (sibling at \
		 {three_lines_pos:?})",
	);

	// 4. Grow multiline to 80 lines (capped by max_visible_lines = 8)
	cx.update(|app| {
		multi_editor.update(app, |ed, cx| ed.set_text(make_80_line_draft(), cx));
	});
	render_frame(&mut cx, &multi_window);

	let capped_pos = multi_sibling_bounds.lock().unwrap();
	assert!(
		capped_pos.top() >= line_h * 8.0 - px(4.0) && capped_pos.top() <= line_h * 8.0 + px(4.0),
		"80-line multiline editor with max_visible_lines(8) must cap element height to 8 lines \
		 (sibling at {capped_pos:?})",
	);

	// Caret in 80-line editor must also be within the 8-line visible viewport
	let viewport_300 = Bounds::new(point(px(0.0), px(0.0)), window_size);
	let caret_bounds = get_caret_bounds(&mut cx, &multi_window, &multi_editor, viewport_300);
	assert!(
		caret_bounds.bottom() <= line_h * 8.0 + px(10.0),
		"Visible multiline editor area with max_visible_lines(8) must cap visible caret bounds to 8 \
		 lines",
	);
}
