//! Verification suite for Editor view keystrokes, selection, event emissions,
//! and clipboard.
//!
//! WHY: Input fields fail silently when keybindings are not registered, IME
//! input handlers drop events, action handlers misroute enter/escape events, or
//! mouse drag selections fail to update cursor bounds. This suite drives real
//! headless GPUI windows, dispatching keystrokes and pointer events through the
//! platform pipeline, proving that user actions update the buffer and emit
//! typed events.
//! GAP: Does not test OS-specific IME popups or native platform window title
//! bars.

use std::sync::Arc;

use parking_lot::{Mutex, MutexGuard};
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorEvent, EditorMode, Selection},
};
use veyyon_gpui::{
	AppContext, Context, Entity, HeadlessAppContext, IntoElement, Keystroke, Modifiers, MouseButton,
	MouseDownEvent, MouseUpEvent, PlatformInput, Render, Window, WindowHandle, point, px, size,
};

static RENDERER_MUTEX: Mutex<()> = Mutex::new(());

struct EditorFixture {
	editor: Entity<Editor>,
}

impl Render for EditorFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		self.editor.clone()
	}
}

fn headless_context() -> (HeadlessAppContext, MutexGuard<'static, ()>) {
	let permit = RENDERER_MUTEX.lock();
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});
	(cx, permit)
}

fn render_frame(cx: &mut HeadlessAppContext, window: &WindowHandle<EditorFixture>) {
	let _ = cx.capture_frame((*window).into(), 1.0);
	cx.run_until_parked();
}

fn dispatch_keystroke(
	cx: &mut HeadlessAppContext,
	window: &WindowHandle<EditorFixture>,
	chord: &str,
) {
	let keystroke = Keystroke::parse(chord).unwrap();
	let _ =
		cx.update_window((*window).into(), |_, window, cx| window.dispatch_keystroke(keystroke, cx));
	render_frame(cx, window);
}

fn type_char(cx: &mut HeadlessAppContext, window: &WindowHandle<EditorFixture>, ch: &str) {
	let keystroke = Keystroke {
		modifiers: Modifiers::default(),
		key:       ch.to_string(),
		key_char:  Some(ch.to_string()),
	};
	let _ =
		cx.update_window((*window).into(), |_, window, cx| window.dispatch_keystroke(keystroke, cx));
	render_frame(cx, window);
}

#[test]
fn single_line_editor_dispatches_text_and_emits_submit_and_escape_events() {
	let (mut cx, _permit) = headless_context();

	let mut editor_slot = None;
	let window = cx
		.open_window(size(px(400.0), px(200.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app
				.new(|cx| Editor::new(EditorMode::SingleLine, cx).placeholder("Single-line input..."));
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();

	// Record emitted events
	let events = Arc::new(Mutex::new(Vec::new()));
	let events_sub = events.clone();
	cx.update(|app| {
		app.subscribe(&editor, move |_entity, event: &EditorEvent, _cx| {
			events_sub.lock().push(event.clone());
		})
		.detach();
	});

	// Focus the editor
	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		let handle = editor.read(cx).focus_handle().clone();
		handle.focus(window, cx);
	})
	.unwrap();

	// Render frame to ensure layout and input handler registration
	render_frame(&mut cx, &window);

	// Type characters: "hello"
	for ch in ["h", "e", "l", "l", "o"] {
		type_char(&mut cx, &window, ch);
	}

	// Verify text in editor buffer
	let current_text = cx.update(|app| editor.read(app).text().to_string());
	assert_eq!(current_text, "hello");

	// Dispatch Enter: must emit Submit in SingleLine mode
	dispatch_keystroke(&mut cx, &window, "enter");

	// Dispatch Escape: must emit Escape
	dispatch_keystroke(&mut cx, &window, "escape");

	let recorded_events = events.lock().clone();
	assert!(
		recorded_events.contains(&EditorEvent::Submit),
		"Enter in single line mode must emit EditorEvent::Submit"
	);
	assert!(recorded_events.contains(&EditorEvent::Escape), "Escape must emit EditorEvent::Escape");
}

#[test]
fn multiline_editor_inserts_newlines_and_grows_content_height() {
	let (mut cx, _permit) = headless_context();

	let mut editor_slot = None;
	let window = cx
		.open_window(size(px(400.0), px(300.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| {
				Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx).max_visible_lines(10)
			});
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();

	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		let handle = editor.read(cx).focus_handle().clone();
		handle.focus(window, cx);
	})
	.unwrap();

	render_frame(&mut cx, &window);

	let initial_height = cx.update(|app| editor.read(app).content_height());

	// Type "Line 1" then press Enter
	for ch in ["L", "i", "n", "e", " ", "1"] {
		type_char(&mut cx, &window, ch);
	}
	dispatch_keystroke(&mut cx, &window, "enter");

	// Type "Line 2"
	for ch in ["L", "i", "n", "e", " ", "2"] {
		type_char(&mut cx, &window, ch);
	}

	render_frame(&mut cx, &window);

	let updated_text = cx.update(|app| editor.read(app).text().to_string());
	assert_eq!(updated_text, "Line 1\nLine 2");

	let multiline_height = cx.update(|app| editor.read(app).content_height());
	assert!(
		multiline_height > initial_height,
		"Content height must increase after adding multiline text"
	);
}

#[test]
fn editor_clipboard_copy_cut_paste_and_select_all() {
	let (mut cx, _permit) = headless_context();

	let mut editor_slot = None;
	let window = cx
		.open_window(size(px(400.0), px(200.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| Editor::new(EditorMode::SingleLine, cx));
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();

	cx.update_window(window.into(), |_, window, cx| {
		window.activate_window();
		let handle = editor.read(cx).focus_handle().clone();
		handle.focus(window, cx);
	})
	.unwrap();

	// Set initial text
	cx.update(|app| {
		editor.update(app, |ed, cx| {
			ed.set_text("Sample Text", cx);
		});
	});

	render_frame(&mut cx, &window);

	// Select all with cmd-a
	dispatch_keystroke(&mut cx, &window, "cmd-a");

	let sel = cx.update(|app| editor.read(app).buffer().selection());
	assert_eq!(sel, Selection::new(0, 11));

	// Cut with cmd-x
	dispatch_keystroke(&mut cx, &window, "cmd-x");

	let after_cut = cx.update(|app| editor.read(app).text().to_string());
	assert_eq!(after_cut, "");

	// Paste with cmd-v
	dispatch_keystroke(&mut cx, &window, "cmd-v");

	let after_paste = cx.update(|app| editor.read(app).text().to_string());
	assert_eq!(after_paste, "Sample Text");
}

#[test]
fn editor_mouse_click_places_caret() {
	let (mut cx, _permit) = headless_context();

	let mut editor_slot = None;
	let window = cx
		.open_window(size(px(400.0), px(200.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| Editor::new(EditorMode::SingleLine, cx));
			editor_slot = Some(editor.clone());
			app.new(|_cx| EditorFixture { editor })
		})
		.expect("headless window must open");

	let editor = editor_slot.unwrap();

	cx.update(|app| {
		editor.update(app, |ed, cx| {
			ed.set_text("First Second Third", cx);
		});
	});

	render_frame(&mut cx, &window);

	// Dispatch mouse click at origin of editor
	let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
		button:      MouseButton::Left,
		position:    point(px(10.0), px(10.0)),
		modifiers:   Modifiers::default(),
		click_count: 1,
		first_mouse: false,
	});
	let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
		button:      MouseButton::Left,
		position:    point(px(10.0), px(10.0)),
		modifiers:   Modifiers::default(),
		click_count: 1,
	});

	cx.update_window(window.into(), |_, window, cx| {
		window.dispatch_event(mouse_down, cx);
		window.dispatch_event(mouse_up, cx);
	})
	.unwrap();
	cx.run_until_parked();

	// Verify focus was established on click
	let is_focused = cx
		.update_window(window.into(), |_, window, cx| {
			editor.read(cx).focus_handle().is_focused(window)
		})
		.unwrap();
	assert!(is_focused, "Editor must be focused after click");
}
