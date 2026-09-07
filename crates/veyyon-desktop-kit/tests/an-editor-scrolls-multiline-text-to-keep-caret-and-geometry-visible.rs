//! Verification suite for Editor multiline layout, caret scrolling,
//! hit-testing, and IME geometry bounds (§8.25).
//!
//! WHY: When typing multiline text exceeding a bounded viewport, the editor
//! must automatically scroll to keep the caret and active lines visible. If
//! scroll_top is not updated or clamped, the caret clips below the viewport,
//! navigation to top fails to restore the view, text deletion leaves stale
//! scroll offsets, and mouse hit testing or IME candidate bounds diverge from
//! rendered text. GAP: Does not drive native OS-level IME popups or platform
//! window decorations.

mod common;
use common::*;
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{
	AppContext, Bounds, Context, Entity, EntityInputHandler, InteractiveElement, IntoElement,
	ParentElement, Pixels, Point, Render, Styled, Window, div, point, px, size,
};

struct AncestorClippedFixture {
	editor:     Entity<Editor>,
	max_height: Pixels,
}

impl Render for AncestorClippedFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.id("ancestor-container")
			.max_h(self.max_height)
			.overflow_hidden()
			.child(self.editor.clone())
	}
}
#[test]
fn eighty_line_draft_scrolls_to_keep_caret_and_final_line_visible_at_bottom() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(200.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 8);

	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(make_80_line_draft(), cx));
	});
	render_frame(&mut cx, &window);

	let caret_bounds = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert!(
		caret_bounds.top() >= viewport.top() && caret_bounds.bottom() <= viewport.bottom() + px(1.0),
		"Caret at {caret_bounds:?} must be within viewport [{:?}, {:?}]",
		viewport.top(),
		viewport.bottom()
	);

	// First line must be scrolled out of view above viewport
	let line1_bounds = get_range_bounds(&mut cx, &window, &editor, 0..5, viewport);
	assert!(
		line1_bounds.bottom() <= viewport.top(),
		"Line 1 ({line1_bounds:?}) must be scrolled above viewport top ({:?})",
		viewport.top()
	);
}

#[test]
fn caret_immediately_after_trailing_newline_is_visible_on_empty_trailing_line() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(200.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 8);

	let mut text = make_80_line_draft();
	text.push('\n');
	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(text, cx));
	});
	render_frame(&mut cx, &window);

	let caret_bounds = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert!(
		caret_bounds.top() >= viewport.top() && caret_bounds.bottom() <= viewport.bottom() + px(1.0),
		"Caret after trailing newline at {caret_bounds:?} must be within viewport [{:?}, {:?}]",
		viewport.top(),
		viewport.bottom()
	);
}

#[test]
fn navigation_to_beginning_and_end_restores_scroll_and_caret_visibility() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(200.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 8);

	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(make_80_line_draft(), cx));
	});
	render_frame(&mut cx, &window);

	// Navigate to beginning
	dispatch_keystroke(&mut cx, &window, "cmd-up");
	let caret_start = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert_eq!(
		caret_start.top(),
		viewport.top(),
		"Caret must be at the very top of viewport after cmd-up"
	);

	let line1_start = get_range_bounds(&mut cx, &window, &editor, 0..5, viewport);
	assert_eq!(line1_start.top(), viewport.top(), "Line 1 must be at the top of viewport");

	// Navigate back to end
	dispatch_keystroke(&mut cx, &window, "cmd-down");
	let caret_end = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert!(
		caret_end.top() >= viewport.top() && caret_end.bottom() <= viewport.bottom() + px(1.0),
		"Caret must be visible at bottom after cmd-down"
	);

	// Move up one line
	dispatch_keystroke(&mut cx, &window, "up");
	let caret_one_up = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert!(caret_one_up.top() <= caret_end.top(), "Caret must move upward on up arrow");
}

#[test]
fn deletion_and_shrinking_text_clamps_stale_scroll_position() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(200.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 8);

	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(make_80_line_draft(), cx));
	});
	dispatch_keystroke(&mut cx, &window, "cmd-down");
	render_frame(&mut cx, &window);

	// Delete lines 3..80 via input handler, leaving only lines 1-2 with caret at
	// end of line 2
	let draft = make_80_line_draft();
	let lines: Vec<&str> = draft.lines().collect();
	let keep_text = format!("{}\n{}", lines[0], lines[1]);
	let keep_len = keep_text.len();
	let total_len = draft.len();

	cx.update_window(window.into(), |_, window, cx| {
		editor.update(cx, |ed, cx| {
			EntityInputHandler::replace_text_in_range(ed, Some(keep_len..total_len), "", window, cx);
		});
	})
	.unwrap();
	render_frame(&mut cx, &window);

	let line1_bounds = get_range_bounds(&mut cx, &window, &editor, 0..5, viewport);
	assert_eq!(
		line1_bounds.top(),
		viewport.top(),
		"Line 1 must be at top of viewport when content shrinks"
	);

	let line2_bounds =
		get_range_bounds(&mut cx, &window, &editor, lines[0].len() + 1..lines[0].len() + 6, viewport);
	let caret_bounds = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert_eq!(
		caret_bounds.top(),
		line2_bounds.top(),
		"Caret on line 2 must match line 2 top when content fits"
	);
	assert!(
		caret_bounds.bottom() <= viewport.bottom(),
		"Caret on shrunk content must be visible in viewport"
	);
}

#[test]
fn hit_testing_and_ime_geometry_remain_aligned_when_scrolled() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(200.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 8);

	let text = make_80_line_draft();
	let total_len = text.len();
	let last_line_start = text.rfind('\n').unwrap() + 1;

	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(text, cx));
	});
	render_frame(&mut cx, &window);

	// IME candidate range on the last visible line
	let ime_bounds =
		get_range_bounds(&mut cx, &window, &editor, last_line_start..total_len, viewport);
	assert!(
		ime_bounds.top() >= viewport.top() && ime_bounds.bottom() <= viewport.bottom() + px(1.0),
		"IME bounds on bottom line {ime_bounds:?} must be within viewport [{:?}, {:?}]",
		viewport.top(),
		viewport.bottom()
	);

	// Hit test at the center of the visible bottom line
	let test_point: Point<Pixels> = point(ime_bounds.left() + px(10.0), ime_bounds.center().y);
	let hit_idx = cx
		.update_window(window.into(), |_, window, cx| {
			editor.update(cx, |ed, cx| {
				ed.character_index_for_point(test_point, window, cx)
					.unwrap()
			})
		})
		.unwrap();

	assert!(
		hit_idx >= last_line_start && hit_idx <= total_len,
		"Hit index {hit_idx} must fall in last line range [{last_line_start}..{total_len}]"
	);
}

#[test]
fn wrapped_text_scrolls_to_keep_caret_on_wrapped_line_visible() {
	let viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(200.0), px(150.0)));
	let (mut cx, _permit, window, editor) = setup_editor_window(viewport, 5);

	let long_paragraph = (1..=30)
		.map(|i| format!("word{i} wrapping text in editor"))
		.collect::<Vec<_>>()
		.join(" ");
	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(long_paragraph, cx));
	});
	render_frame(&mut cx, &window);

	let caret_bounds = get_caret_bounds(&mut cx, &window, &editor, viewport);
	assert!(
		caret_bounds.top() >= viewport.top() && caret_bounds.bottom() <= viewport.bottom() + px(1.0),
		"Caret on wrapped line at {caret_bounds:?} must be within viewport [{:?}, {:?}]",
		viewport.top(),
		viewport.bottom()
	);
}
#[test]
fn ancestor_clipped_height_caps_scroll_viewport_correctly() {
	let (mut cx, _permit) = headless_context();
	let window_bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), px(300.0)));
	let max_ancestor_h = px(100.0);
	let ancestor_viewport = Bounds::new(point(px(0.0), px(0.0)), size(px(400.0), max_ancestor_h));

	let mut editor_slot = None;
	let window = cx
		.open_window(window_bounds.size, |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx).max_visible_lines(20)
			});
			editor_slot = Some(editor.clone());
			app.new(|_cx| AncestorClippedFixture { editor, max_height: max_ancestor_h })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();
	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		editor.read(cx).focus_handle().clone().focus(window, cx);
	})
	.unwrap();

	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(make_80_line_draft(), cx));
	});
	render_frame(&mut cx, &window);

	let caret_bounds = get_caret_bounds(&mut cx, &window, &editor, ancestor_viewport);
	assert!(
		caret_bounds.top() >= ancestor_viewport.top()
			&& caret_bounds.bottom() <= ancestor_viewport.bottom() + px(1.0),
		"Caret at {caret_bounds:?} must be within ancestor-clipped viewport [{:?}, {:?}]",
		ancestor_viewport.top(),
		ancestor_viewport.bottom()
	);
}
