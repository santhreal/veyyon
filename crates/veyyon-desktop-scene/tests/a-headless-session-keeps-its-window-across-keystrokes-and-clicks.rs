//! WHY THIS SUITE EXISTS
//!
//! Multi-step interaction testing (keystroke typing, focus switching, clicks,
//! and animations) requires a persistent window that survives across sequential
//! input events and frame captures. If a test harness tears down the window
//! between each frame, stateful element focus, IME input accumulation and mouse
//! interaction cannot be defended against regression.
//!
//! This suite proves that [`veyyon_desktop_scene::HeadlessSession`] maintains
//! window lifecycle, routes keystrokes to the focused input handler, delivers
//! mouse clicks to interactive elements at their layout hitboxes, and produces
//! byte-identical frames when quiescent while producing differing frames after
//! user input.
//!
//! THE CLASS THIS CLOSES: broken input routing, lost input focus, window
//! recreation leaks, and non-deterministic frame generation across interactive
//! event steps.
//!
//! WHAT IT DOES NOT CATCH: OS-specific native platform window manager events
//! and display server composition artifacts.

use std::ops::Range;

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	App, AppContext, Bounds, Context, ElementInputHandler, EntityInputHandler, FocusHandle,
	Focusable, InteractiveElement, IntoElement, MouseButton, ParentElement as _, Pixels, Point,
	Render, Styled as _, UTF16Selection, Window, canvas, div, px, rgb, white,
};

struct InteractiveView {
	focus_handle: FocusHandle,
	text:         String,
	clicks:       usize,
}

impl InteractiveView {
	fn new(cx: &mut Context<Self>) -> Self {
		Self { focus_handle: cx.focus_handle(), text: String::new(), clicks: 0 }
	}
}

impl Focusable for InteractiveView {
	fn focus_handle(&self, _cx: &App) -> FocusHandle {
		self.focus_handle.clone()
	}
}

impl EntityInputHandler for InteractiveView {
	fn text_for_range(
		&mut self,
		_range: Range<usize>,
		_adjusted_range: &mut Option<Range<usize>>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<String> {
		Some(self.text.clone())
	}

	fn selected_text_range(
		&mut self,
		_ignore_disabled_input: bool,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<UTF16Selection> {
		None
	}

	fn marked_text_range(
		&self,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Range<usize>> {
		None
	}

	fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {}

	fn replace_text_in_range(
		&mut self,
		_range: Option<Range<usize>>,
		text: &str,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.text.push_str(text);
		cx.notify();
	}

	fn replace_and_mark_text_in_range(
		&mut self,
		_range: Option<Range<usize>>,
		new_text: &str,
		_new_selected_range: Option<Range<usize>>,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.text.push_str(new_text);
		cx.notify();
	}

	fn bounds_for_range(
		&mut self,
		_range_utf16: Range<usize>,
		_element_bounds: Bounds<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<Bounds<Pixels>> {
		None
	}

	fn character_index_for_point(
		&mut self,
		_point: Point<Pixels>,
		_window: &mut Window,
		_cx: &mut Context<Self>,
	) -> Option<usize> {
		None
	}
}

impl Render for InteractiveView {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let view = cx.entity();
		let focus_handle = self.focus_handle.clone();
		let text = self.text.clone();
		let clicks = self.clicks;

		div()
			.size_full()
			.bg(rgb(0x18181b))
			.text_color(white())
			.flex()
			.flex_col()
			.gap(px(8.0))
			.p(px(16.0))
			.child(
				div()
					.id("input-box")
					.w(px(200.0))
					.h(px(32.0))
					.bg(rgb(0x27272a))
					.p(px(4.0))
					.track_focus(&focus_handle)
					.child(
						canvas(
							|_, _, _| {},
							move |bounds, (), window, cx| {
								window.handle_input(
									&focus_handle,
									ElementInputHandler::new(bounds, view),
									cx,
								);
							},
						)
						.size_full(),
					)
					.child(div().child(format!("Text: {text}"))),
			)
			.child(
				div()
					.id("click-button")
					.w(px(120.0))
					.h(px(32.0))
					.bg(rgb(0x3f3f46))
					.on_mouse_down(
						MouseButton::Left,
						cx.listener(|this, _, _, cx| {
							this.clicks += 1;
							cx.notify();
						}),
					)
					.child(format!("Clicks: {clicks}")),
			)
	}
}

#[test]
fn a_headless_session_keeps_its_window_across_keystrokes_and_clicks() {
	let mut cx = headless_context().expect("headless context must be available");
	let options = RenderOptions { width: 320, height: 240, scale_factor: 1.0, ..Default::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, |window, app| {
		let entity = app.new(InteractiveView::new);
		let focus_handle = entity.read(app).focus_handle.clone();
		focus_handle.focus(window, app);
		entity
	})
	.expect("session must open");

	// Initial frame capture
	let frame1 = session.frame().expect("capture frame 1");
	assert!(!frame1.hitboxes.is_empty(), "frame 1 must register hitboxes");

	// A second frame without interaction produces byte-identical output
	let frame2 = session.frame().expect("capture frame 2");
	assert_eq!(
		frame1.frame.as_bytes(),
		frame2.frame.as_bytes(),
		"quiescent session must produce identical bytes"
	);

	// Type text into the focused input element
	session.type_text("hello").expect("type text must succeed");

	let _view_entity = session.root();
	let text_after_type = session
		.update(|view, _, _| view.text.clone())
		.expect("update view");
	assert_eq!(text_after_type, "hello", "typed text must reach input handler");

	// Frame after typing must differ from the initial frame
	let frame_typed = session.frame().expect("capture frame after typing");
	assert_ne!(
		frame1.frame.as_bytes(),
		frame_typed.frame.as_bytes(),
		"rendered frame must change after typing"
	);

	// Click on the button at (60, 60)
	let button_click_point = Point { x: px(60.0), y: px(60.0) };
	session
		.click(button_click_point)
		.expect("click must succeed");

	let clicks_after = session
		.update(|view, _, _| view.clicks)
		.expect("update view clicks");
	assert_eq!(clicks_after, 1, "click at hitbox must increment click counter");

	// Second click
	session
		.click(button_click_point)
		.expect("second click must succeed");
	let clicks_after_two = session
		.update(|view, _, _| view.clicks)
		.expect("update view clicks 2");
	assert_eq!(clicks_after_two, 2, "second click must increment counter again");
}
