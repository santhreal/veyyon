//! A text editor view: a single-line field or a soft-wrapped multi-line area.
//!
//! [`TextBuffer`] holds the text, the selection and the undo history and has
//! no notion of pixels. [`Editor`] is the view over it: it shapes and wraps the
//! text to its width, paints the caret and selection, hit-tests the pointer
//! through the shaped lines, accepts input-method composition and reports
//! [`EditorEvent`]s. Keys are bound in the [`KEY_CONTEXT`] key context.

pub mod actions;
mod buffer;
mod element;
mod handlers;
mod history;
mod input;
mod layout;
mod motion;
mod render;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod view_tests;

use std::{borrow::Cow, ops::Range, rc::Rc, time::Duration};

pub use actions::KEY_CONTEXT;
pub use buffer::{Motion, Selection, TextBuffer, Unit};
pub use history::{EditKind, UNDO_LIMIT};
use veyyon_gpui::{
	App, Bounds, Context, EventEmitter, FocusHandle, Focusable, Pixels, Point, SharedString,
	Subscription, Task, Window,
};

use self::layout::TextLayout;
use crate::theme::{TypeStyle, text};

/// Time between caret blink phases.
const BLINK_INTERVAL: Duration = Duration::from_millis(530);

/// Whether the editor holds one line or many.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorMode {
	/// One line, scrolled horizontally. Enter and Shift-Enter submit; a line
	/// break in pasted or set text becomes a space.
	SingleLine,
	/// Many lines, soft-wrapped to the element width. Shift-Enter inserts a
	/// line break; Enter submits when `submit_on_enter` is set and inserts a
	/// line break otherwise.
	MultiLine {
		/// Enter submits instead of breaking the line.
		submit_on_enter: bool,
	},
}

/// What the editor reports to its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorEvent {
	/// The text changed.
	Changed,
	/// Enter was pressed in a mode that submits.
	Submit,
	/// Up was pressed with the caret on the first row.
	HistoryPrev,
	/// Down was pressed with the caret on the last row.
	HistoryNext,
	/// Escape was pressed.
	Escape,
	/// The editor gained keyboard focus.
	Focused,
	/// The editor lost keyboard focus.
	Blurred,
}

/// A text editor view.
pub struct Editor {
	buffer:               TextBuffer,
	focus_handle:         FocusHandle,
	mode:                 EditorMode,
	placeholder:          SharedString,
	text_style:           TypeStyle,
	min_lines:            usize,
	max_lines:            Option<usize>,
	/// The input method's uncommitted text.
	marked:               Option<Range<usize>>,
	/// The horizontal position vertical motion returns to.
	goal_x:               Option<Pixels>,
	/// The layout and element bounds of the last frame.
	layout:               Option<Rc<TextLayout>>,
	bounds:               Option<Bounds<Pixels>>,
	scroll:               Point<Pixels>,
	/// Scroll the caret into view on the next frame.
	autoscroll:           bool,
	/// A primary-button drag is extending the selection.
	selecting:            bool,
	focused:              bool,
	caret_visible:        bool,
	/// An edit or motion happened since the last blink phase.
	typed:                bool,
	/// The blink timer; `None` while unfocused.
	blink:                Option<Task<()>>,
	_focus_subscriptions: [Subscription; 2],
}

impl Editor {
	/// An empty editor in `mode`, drawn in [`text::BODY`].
	pub fn new(mode: EditorMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
		actions::bind_keys(cx);
		let focus_handle = cx.focus_handle();
		let subscriptions = [
			cx.on_focus(&focus_handle, window, |editor, _, cx| editor.focus_changed(true, cx)),
			cx.on_blur(&focus_handle, window, |editor, _, cx| editor.focus_changed(false, cx)),
		];
		Self {
			buffer: TextBuffer::new(),
			focus_handle,
			mode,
			placeholder: SharedString::default(),
			text_style: text::BODY,
			min_lines: 1,
			max_lines: None,
			marked: None,
			goal_x: None,
			layout: None,
			bounds: None,
			scroll: Point::default(),
			autoscroll: false,
			selecting: false,
			focused: false,
			caret_visible: false,
			typed: false,
			blink: None,
			_focus_subscriptions: subscriptions,
		}
	}

	/// The mode.
	pub const fn mode(&self) -> EditorMode {
		self.mode
	}

	/// The text.
	pub fn text(&self) -> &str {
		self.buffer.text()
	}

	/// True when the text is empty.
	pub const fn is_empty(&self) -> bool {
		self.buffer.is_empty()
	}

	/// The buffer: text, selection and history.
	pub const fn buffer(&self) -> &TextBuffer {
		&self.buffer
	}

	/// True while the editor has keyboard focus.
	pub const fn is_focused(&self) -> bool {
		self.focused
	}

	/// Replaces the text as one undo step, the caret at its end.
	pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
		let text = self.sanitize(text);
		self.marked = None;
		self.buffer.set_text(&text);
		self.changed(cx);
	}

	/// Sets the text drawn in `text.faint` while the editor is empty.
	pub fn set_placeholder(&mut self, placeholder: impl Into<SharedString>, cx: &mut Context<Self>) {
		self.placeholder = placeholder.into();
		cx.notify();
	}

	/// Sets the type ramp step the text is drawn in.
	pub fn set_text_style(&mut self, style: TypeStyle, cx: &mut Context<Self>) {
		self.text_style = style;
		cx.notify();
	}

	/// Sets the fewest and most rows a multi-line editor shows; past `max` the
	/// content scrolls inside the editor. A single-line editor shows one row.
	pub fn set_line_limits(&mut self, min: usize, max: Option<usize>, cx: &mut Context<Self>) {
		self.min_lines = min.max(1);
		self.max_lines = max.map(|max| max.max(self.min_lines));
		cx.notify();
	}

	/// The caret's byte offset.
	pub const fn cursor_offset(&self) -> usize {
		self.buffer.cursor()
	}

	/// Moves the caret to `offset`, floored to a grapheme boundary, and clears
	/// the selection.
	pub fn set_cursor_offset(&mut self, offset: usize, cx: &mut Context<Self>) {
		self.marked = None;
		self.buffer.move_to(offset, false);
		self.moved(cx);
	}

	/// Replaces the byte `range` with `text` as its own undo step and returns
	/// the range the new text occupies; the caret lands after it.
	pub fn replace_range(
		&mut self,
		range: Range<usize>,
		text: &str,
		cx: &mut Context<Self>,
	) -> Range<usize> {
		let text = self.sanitize(text);
		self.marked = None;
		let inserted = self.buffer.replace_range(range, &text);
		self.changed(cx);
		inserted
	}

	/// Moves keyboard focus to the editor.
	pub fn focus(&self, window: &mut Window, cx: &mut App) {
		self.focus_handle.focus(window, cx);
	}

	const fn wraps(&self) -> bool {
		matches!(self.mode, EditorMode::MultiLine { .. })
	}

	/// The fewest and most rows the element sizes itself to.
	const fn row_limits(&self) -> (usize, Option<usize>) {
		match self.mode {
			EditorMode::SingleLine => (1, Some(1)),
			EditorMode::MultiLine { .. } => (self.min_lines, self.max_lines),
		}
	}

	/// The last layout, when it was shaped from the current text and holds one
	/// shaped line per logical line.
	fn current_layout(&self) -> Option<Rc<TextLayout>> {
		self.layout
			.as_ref()
			.filter(|layout| {
				!layout.placeholder
					&& layout.revision == self.buffer.revision()
					&& layout.lines.len() == self.buffer.line_count()
			})
			.cloned()
	}

	/// Normalizes line breaks to `\n`, or to spaces in a single-line editor.
	fn sanitize<'a>(&self, text: &'a str) -> Cow<'a, str> {
		let single = !self.wraps();
		let rewrites = text.contains('\r') || (single && text.contains('\n'));
		if !rewrites {
			return Cow::Borrowed(text);
		}
		let text = text.replace("\r\n", "\n").replace('\r', "\n");
		Cow::Owned(if single { text.replace('\n', " ") } else { text })
	}

	/// After a caret or selection change: forget the goal column, then show
	/// the caret.
	fn moved(&mut self, cx: &mut Context<Self>) {
		self.goal_x = None;
		self.show_caret(cx);
	}

	/// After a text change.
	fn changed(&mut self, cx: &mut Context<Self>) {
		self.moved(cx);
		cx.emit(EditorEvent::Changed);
	}

	/// Holds the caret solid through the next blink phase and scrolls it into
	/// view.
	fn show_caret(&mut self, cx: &mut Context<Self>) {
		self.typed = true;
		self.caret_visible = self.focused;
		self.autoscroll = true;
		cx.notify();
	}

	fn focus_changed(&mut self, focused: bool, cx: &mut Context<Self>) {
		self.focused = focused;
		self.caret_visible = focused;
		if focused {
			self.start_blink(cx);
			cx.emit(EditorEvent::Focused);
		} else {
			self.blink = None;
			self.selecting = false;
			self.marked = None;
			cx.emit(EditorEvent::Blurred);
		}
		cx.notify();
	}

	/// Starts the one timer that blinks the caret. It ends itself when the
	/// editor blurs, and dropping it on blur cancels a pending phase, so a
	/// blurred editor schedules no frames.
	fn start_blink(&mut self, cx: &Context<Self>) {
		self.blink = Some(cx.spawn(async move |editor, cx| {
			loop {
				cx.background_executor().timer(BLINK_INTERVAL).await;
				let blinking = editor.update(cx, |editor, cx| editor.blink_phase(cx));
				if !matches!(blinking, Ok(true)) {
					break;
				}
			}
		}));
	}

	/// Toggles the caret, or keeps it solid when there was input since the
	/// last phase. Returns false once the editor is unfocused.
	fn blink_phase(&mut self, cx: &mut Context<Self>) -> bool {
		if !self.focused {
			return false;
		}
		if std::mem::take(&mut self.typed) {
			self.caret_visible = true;
		} else {
			self.caret_visible = !self.caret_visible;
			cx.notify();
		}
		true
	}
}

impl Focusable for Editor {
	fn focus_handle(&self, _cx: &App) -> FocusHandle {
		self.focus_handle.clone()
	}
}

impl EventEmitter<EditorEvent> for Editor {}
