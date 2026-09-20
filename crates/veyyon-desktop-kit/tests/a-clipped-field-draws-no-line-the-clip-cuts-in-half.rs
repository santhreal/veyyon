//! WHY: the composer clips the editor to a float whose height is authored in
//! pixels, so the room the text gets is almost never a whole number of lines.
//! The scroll offset was taken straight off the caret, which put the remainder
//! at the TOP of the viewport: the first visible line was sliced through the
//! middle of its glyphs, one hairline under the float's lit rim, and read as a
//! misdraw rather than as text continuing above.
//!
//! THE CLASS THIS CLOSES: a clipped text viewport whose scroll offset is not a
//! whole number of lines. The sweep is every remainder a line height can leave
//! -- derived at run time from the measured line height, not a list -- with the
//! caret driven to the end of a draft that overflows, which is the only state
//! that scrolls. A viewport that cuts a line at its top edge fails by the
//! remainder that produced it, and a line height change re-derives the sweep
//! with no edit here.
//!
//! WHAT IT DOES NOT CATCH: where the slack lands horizontally, and whether the
//! clip is the right height to begin with. It also says nothing about a
//! viewport shorter than one line, which draws no whole line by definition.

mod common;
use common::*;
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{
	AppContext, Bounds, Context, Entity, InteractiveElement, IntoElement, ParentElement, Pixels,
	Render, Styled, Window, WindowHandle, div, point, px, size,
};

/// The editor under a clip of a definite height, which is what the composer's
/// float is: the editor asks for the room its lines need and gets whatever the
/// float has left.
struct ClippedFixture {
	editor: Entity<Editor>,
	height: Pixels,
}

impl Render for ClippedFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.id("clip")
			.h(self.height)
			.overflow_hidden()
			.child(self.editor.clone())
	}
}

const WIDTH: f32 = 400.0;

/// Opens a window holding a clip `height` tall over a draft of `lines` lines,
/// with the caret left at the end of the draft.
fn clipped_draft(
	height: f32,
	lines: usize,
) -> (
	veyyon_gpui::HeadlessAppContext,
	parking_lot::MutexGuard<'static, ()>,
	WindowHandle<ClippedFixture>,
	Entity<Editor>,
) {
	let (mut cx, permit) = headless_context();
	let mut slot = None;
	let window = cx
		.open_window(size(px(WIDTH), px(height + 40.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor =
				app.new(|cx| Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx));
			slot = Some(editor.clone());
			app.new(|_cx| ClippedFixture { editor, height: px(height) })
		})
		.expect("headless window must open");

	let editor = slot.expect("the fixture holds the editor it built");
	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		editor.read(cx).focus_handle().clone().focus(window, cx);
	})
	.expect("the window takes focus");

	let draft = (1..=lines)
		.map(|i| format!("Line {i:02} content in draft"))
		.collect::<Vec<_>>()
		.join("\n");
	cx.update(|app| {
		editor.update(app, |ed, cx| ed.set_text(draft, cx));
	});
	render_frame(&mut cx, &window);
	(cx, permit, window, editor)
}

/// The y the frame drew visual line `index` at, in the clip's own coordinates.
fn line_top(
	cx: &mut veyyon_gpui::HeadlessAppContext,
	window: &WindowHandle<ClippedFixture>,
	editor: &Entity<Editor>,
	clip: Bounds<Pixels>,
	index: usize,
) -> f32 {
	// Every line of the draft is the same length, so the byte range of line
	// `index` is arithmetic rather than a search.
	let stride = "Line 01 content in draft\n".len();
	let start = index * stride;
	f32::from(get_range_bounds(cx, window, editor, start..start + 4, clip).top())
}

/// The line height the window sets, measured off two drawn lines rather than
/// read from the token set, so the sweep below follows whatever the frame did.
fn measured_line_height() -> f32 {
	let clip = Bounds::new(point(px(0.0), px(0.0)), size(px(WIDTH), px(400.0)));
	let (mut cx, _permit, window, editor) = clipped_draft(400.0, 3);
	let first = line_top(&mut cx, &window, &editor, clip, 0);
	let second = line_top(&mut cx, &window, &editor, clip, 1);
	let height = second - first;
	assert!(height > 1.0, "two drawn lines are {height}px apart, which is no line height");
	height
}

#[test]
fn a_clip_that_is_not_a_whole_number_of_lines_still_starts_on_one() {
	let line_height = measured_line_height();
	let lines = 40;

	// Every remainder a line height can leave, which is the whole variant
	// space: a clip six lines tall plus one pixel, plus two, and so on to one
	// pixel short of a seventh line.
	for slack in 1..line_height.round() as usize {
		let height = line_height.mul_add(6.0, slack as f32);
		let clip = Bounds::new(point(px(0.0), px(0.0)), size(px(WIDTH), px(height)));
		let (mut cx, _permit, window, editor) = clipped_draft(height, lines);

		let first = line_top(&mut cx, &window, &editor, clip, 0);
		assert!(
			first < -1.0,
			"a {height}px clip over {lines} lines drew line 1 at {first}, so nothing scrolled and \
			 this case proves nothing"
		);

		// The offset is a whole number of lines exactly when some line starts
		// on the clip's top edge; otherwise one line is cut through.
		let offset = -first;
		let cut = offset % line_height;
		assert!(
			cut < 0.5 || line_height - cut < 0.5,
			"a {height}px clip scrolled {offset}px, {cut}px into a line, so the top line is drawn \
			 with its glyphs cut by the clip"
		);

		// The caret's line stays drawn. Snapping moves the text up, so a
		// viewport that gained a whole line at the top must not have lost the
		// line the operator is typing on.
		let last = line_top(&mut cx, &window, &editor, clip, lines - 1);
		assert!(
			last >= -0.5 && last + line_height <= height + 0.5,
			"a {height}px clip drew the caret's line at {last}, outside the clip, so snapping the \
			 offset scrolled past what is being typed"
		);

		// The slack it leaves is at the bottom, and it is less than a line:
		// more than that is a blank row the operator paid a line of text for.
		let slack_px = height - (last + line_height);
		assert!(
			slack_px < line_height,
			"a {height}px clip left {slack_px}px under the last line, a whole line of blank ground"
		);
	}
}
