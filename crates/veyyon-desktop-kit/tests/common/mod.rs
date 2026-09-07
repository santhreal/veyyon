#![allow(dead_code, unused_imports)]
//! Shared helpers and fixtures for veyyon-desktop-kit integration tests.

use std::ops::Range;

use parking_lot::{Mutex, MutexGuard};
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{
	AppContext, Bounds, Context, Entity, EntityInputHandler, HeadlessAppContext, IntoElement,
	Keystroke, Pixels, Point, Render, Window, WindowHandle, px,
};

static RENDERER_MUTEX: Mutex<()> = Mutex::new(());

pub struct EditorFixture {
	pub editor: Entity<Editor>,
}

impl Render for EditorFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		self.editor.clone()
	}
}

pub fn headless_context() -> (HeadlessAppContext, MutexGuard<'static, ()>) {
	let permit = RENDERER_MUTEX.lock();
	let cx = veyyon_desktop_kit::headless::app_context()
		.expect("a GPU with a Vulkan ICD is required for this suite");
	(cx, permit)
}

pub fn setup_editor_window(
	viewport: Bounds<Pixels>,
	max_visible_lines: usize,
) -> (HeadlessAppContext, MutexGuard<'static, ()>, WindowHandle<EditorFixture>, Entity<Editor>) {
	let (mut cx, permit) = headless_context();
	let mut editor_slot = None;
	let window = cx
		.open_window(viewport.size, |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx)
					.max_visible_lines(max_visible_lines)
			});
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();
	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		editor.read(cx).focus_handle().clone().focus(window, cx);
	})
	.unwrap();
	(cx, permit, window, editor)
}

pub fn render_frame<T: 'static + Render>(cx: &mut HeadlessAppContext, window: &WindowHandle<T>) {
	let _ = cx.capture_frame((*window).into(), 1.0);
	cx.run_until_parked();
}

pub fn dispatch_keystroke<T: 'static + Render>(
	cx: &mut HeadlessAppContext,
	window: &WindowHandle<T>,
	chord: &str,
) {
	let keystroke = Keystroke::parse(chord).unwrap();
	let _ =
		cx.update_window((*window).into(), |_, window, cx| window.dispatch_keystroke(keystroke, cx));
	render_frame(cx, window);
}

pub fn make_80_line_draft() -> String {
	(1..=80)
		.map(|i| format!("Line {i:02} content in draft"))
		.collect::<Vec<_>>()
		.join("\n")
}

pub fn get_caret_bounds<T: 'static + Render>(
	cx: &mut HeadlessAppContext,
	window: &WindowHandle<T>,
	editor: &Entity<Editor>,
	viewport_bounds: Bounds<Pixels>,
) -> Bounds<Pixels> {
	cx.update_window((*window).into(), |_, window, cx| {
		editor.update(cx, |ed, cx| {
			let sel = ed.selected_text_range(false, window, cx).unwrap();
			ed.bounds_for_range(sel.range, viewport_bounds, window, cx)
				.unwrap()
		})
	})
	.unwrap()
}

pub fn get_range_bounds<T: 'static + Render>(
	cx: &mut HeadlessAppContext,
	window: &WindowHandle<T>,
	editor: &Entity<Editor>,
	range: Range<usize>,
	viewport_bounds: Bounds<Pixels>,
) -> Bounds<Pixels> {
	cx.update_window((*window).into(), |_, window, cx| {
		editor.update(cx, |ed, cx| {
			ed.bounds_for_range(range, viewport_bounds, window, cx)
				.unwrap()
		})
	})
	.unwrap()
}
