//! GPUI interactive Editor view managing text buffer, caret, selection, and key
//! events (§8.25).

use std::ops::Range;

pub mod actions;
pub mod bindings;
pub mod element;
pub mod handlers;
pub mod input_handler;
pub mod layout;
pub mod mouse;
pub mod navigation;
pub mod slot;
pub use actions::*;
pub use bindings::ensure_editor_bindings_registered;
pub use element::EditorElement;
pub use layout::EditorLayoutState;
pub use slot::EditorSlot;
use veyyon_gpui::{
	App, ClipboardItem, Context, CursorStyle, ElementId, EventEmitter, FocusHandle, Focusable,
	InteractiveElement, IntoElement, MouseButton, Pixels, Render, SharedString, Subscription, Task,
	Window, div, prelude::*,
};

use super::buffer::TextBuffer;

/// Operation mode for editor instances.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EditorMode {
	/// Single-line text input field. Bare enter emits submit.
	#[default]
	SingleLine,
	/// Multiline text area. Enter inserts a newline when `newline_on_enter` is
	/// true.
	Multiline {
		/// If true, bare enter inserts a newline; otherwise emits submit.
		newline_on_enter: bool,
	},
}

/// Events emitted by the Editor view to subscribers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorEvent {
	/// Text content changed.
	Changed,
	/// Form submission triggered (e.g. Enter pressed).
	Submit,
	/// Escape key pressed.
	Escape,
	/// A paste whose clipboard held no text: the image or file entries it did
	/// hold, for the owner to attach. The editor inserts nothing for it.
	PasteMedia(ClipboardItem),
}

/// Interactive text editor GPUI view entity.
pub struct Editor {
	pub(crate) buffer:            TextBuffer,
	pub(crate) focus_handle:      FocusHandle,
	pub(crate) mode:              EditorMode,
	pub(crate) placeholder:       SharedString,
	pub(crate) max_visible_lines: Option<usize>,
	pub(crate) content_height:    Pixels,
	pub(crate) cursor_visible:    bool,
	pub(crate) scroll_top:        Pixels,
	pub(crate) marked_range:      Option<Range<usize>>,
	pub(crate) goal_column:       Option<Pixels>,
	pub(crate) last_layout:       Option<EditorLayoutState>,
	pub(crate) is_selecting:      bool,
	pub(crate) blink_task:        Task<()>,
	pub(crate) _subscriptions:    Vec<Subscription>,
}

impl Editor {
	/// Creates a new editor view in the specified mode.
	#[must_use]
	pub fn new(mode: EditorMode, cx: &mut Context<Self>) -> Self {
		ensure_editor_bindings_registered(cx);
		let focus_handle = cx.focus_handle();

		Self {
			buffer: TextBuffer::new(),
			focus_handle,
			mode,
			placeholder: SharedString::default(),
			max_visible_lines: None,
			content_height: Pixels::ZERO,
			cursor_visible: true,
			scroll_top: Pixels::ZERO,
			marked_range: None,
			goal_column: None,
			last_layout: None,
			is_selecting: false,
			blink_task: Task::ready(()),
			_subscriptions: Vec::new(),
		}
	}

	/// Sets placeholder text displayed when editor is empty.
	#[must_use]
	pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
		self.placeholder = placeholder.into();
		self
	}

	/// Sets maximum visible lines before vertical scrolling engages.
	#[must_use]
	pub fn max_visible_lines(mut self, lines: usize) -> Self {
		self.max_visible_lines = Some(lines.max(1));
		self
	}

	/// Returns current text content.
	#[must_use]
	pub fn text(&self) -> &str {
		self.buffer.text()
	}

	/// Returns true if text content is empty.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.buffer.is_empty()
	}

	/// Returns reference to internal text buffer.
	#[must_use]
	pub const fn buffer(&self) -> &TextBuffer {
		&self.buffer
	}

	/// Returns mutable reference to internal text buffer.
	#[must_use]
	pub fn buffer_mut(&mut self) -> &mut TextBuffer {
		&mut self.buffer
	}

	/// Sets text content, resetting cursor to end and notifying subscribers.
	pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
		self.buffer.set_text(text);
		self.marked_range = None;
		self.goal_column = None;
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	/// Clears all text, returning previous content and notifying subscribers.
	pub fn take_text(&mut self, cx: &mut Context<Self>) -> String {
		let prev = self.buffer.clear();
		self.marked_range = None;
		self.goal_column = None;
		cx.emit(EditorEvent::Changed);
		cx.notify();
		prev
	}

	/// Returns reference to focus handle.
	#[must_use]
	pub const fn focus_handle(&self) -> &FocusHandle {
		&self.focus_handle
	}

	/// Returns last laid-out content height.
	#[must_use]
	pub const fn content_height(&self) -> Pixels {
		self.content_height
	}

	/// Returns active editor mode.
	#[must_use]
	pub const fn mode(&self) -> EditorMode {
		self.mode
	}

	/// Sets editor mode.
	pub fn set_mode(&mut self, mode: EditorMode, cx: &mut Context<Self>) {
		self.mode = mode;
		cx.notify();
	}
}

impl Focusable for Editor {
	fn focus_handle(&self, _cx: &App) -> FocusHandle {
		self.focus_handle.clone()
	}
}

impl EventEmitter<EditorEvent> for Editor {}

impl Render for Editor {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.id(ElementId::from("editor"))
			.key_context("Editor")
			.track_focus(&self.focus_handle)
			.cursor(CursorStyle::IBeam)
			.w_full()
			.overflow_hidden()
			.on_action(cx.listener(Self::select_all_action))
			.on_action(cx.listener(Self::undo_action))
			.on_action(cx.listener(Self::redo_action))
			.on_action(cx.listener(Self::copy_action))
			.on_action(cx.listener(Self::cut_action))
			.on_action(cx.listener(Self::paste_action))
			.on_action(cx.listener(Self::newline_action))
			.on_action(cx.listener(Self::enter_action))
			.on_action(cx.listener(Self::escape_action))
			.on_action(cx.listener(Self::move_left_action))
			.on_action(cx.listener(Self::move_right_action))
			.on_action(cx.listener(Self::move_up_action))
			.on_action(cx.listener(Self::move_down_action))
			.on_action(cx.listener(Self::select_left_action))
			.on_action(cx.listener(Self::select_right_action))
			.on_action(cx.listener(Self::select_up_action))
			.on_action(cx.listener(Self::select_down_action))
			.on_action(cx.listener(Self::move_word_left_action))
			.on_action(cx.listener(Self::move_word_right_action))
			.on_action(cx.listener(Self::select_word_left_action))
			.on_action(cx.listener(Self::select_word_right_action))
			.on_action(cx.listener(Self::move_line_start_action))
			.on_action(cx.listener(Self::move_line_end_action))
			.on_action(cx.listener(Self::select_line_start_action))
			.on_action(cx.listener(Self::select_line_end_action))
			.on_action(cx.listener(Self::move_doc_start_action))
			.on_action(cx.listener(Self::move_doc_end_action))
			.on_action(cx.listener(Self::select_doc_start_action))
			.on_action(cx.listener(Self::select_doc_end_action))
			.on_action(cx.listener(Self::backspace_action))
			.on_action(cx.listener(Self::delete_action))
			.on_action(cx.listener(Self::delete_word_backward_action))
			.on_action(cx.listener(Self::delete_word_forward_action))
			.on_action(cx.listener(Self::delete_to_line_start_action))
			.on_action(cx.listener(Self::delete_to_line_end_action))
			.on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
			.on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_move(cx.listener(Self::on_mouse_move))
			.child(EditorElement { editor: cx.entity() })
	}
}
