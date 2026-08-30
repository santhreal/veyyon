//! A text field that wraps, grows, and edits like a text field is expected to.
//!
//! gpui draws text and shapes lines; it has no editor. This module is the one,
//! and it is the only place in the window that owns a caret. The composer uses
//! it multiline, the palette and the settings fields use it single line, and
//! the difference is two flags rather than two implementations.
//!
//! What "edits like a text field" means here, concretely: the caret moves by
//! grapheme and by word, up and down through wrapped rows rather than through
//! logical lines, home and end land on the visual row, a drag selects, a double
//! click takes the word, an IME's marked text is underlined in place, and the
//! field scrolls to keep the caret in view once the text is taller than the
//! field is allowed to get.
//!
//! The pure part of that (where a boundary is, what a replacement produces,
//! where a utf16 offset lands) is in [`text`], as free functions over `&str`,
//! and that is where the tests are. The rest needs a window.

use std::{ops::Range, sync::Arc, time::Duration};

use gpui::{
	App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, Element, ElementId,
	ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
	GlobalElementId, InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent,
	MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ScrollWheelEvent, SharedString, Size,
	Style, Task, TextAlign, TextRun, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions,
	div, fill, point, prelude::*, px, relative, size,
};

use crate::theme::Theme;

actions!(editor, [
	Backspace,
	Delete,
	DeleteWordLeft,
	DeleteWordRight,
	DeleteToLineEnd,
	Left,
	Right,
	Up,
	Down,
	WordLeft,
	WordRight,
	Home,
	End,
	DocStart,
	DocEnd,
	SelectLeft,
	SelectRight,
	SelectUp,
	SelectDown,
	SelectWordLeft,
	SelectWordRight,
	SelectHome,
	SelectEnd,
	SelectAll,
	Newline,
	Submit,
	Paste,
	Cut,
	Copy,
	ShowCharacterPalette,
]);

/// The caret's blink half-period, from the motion catalog: the caret is one
/// more thing that moves on this app's clock, not a private timer.
const BLINK: Duration = Duration::from_millis(crate::motion::BLINK_MS as u64);

/// A frame's shaped text. Shared rather than cloned: a [`WrappedLine`] holds an
/// `Arc` to its layout but is not itself cloneable, and both the entity (for
/// hit testing) and the paint pass need the same lines.
type Lines = Arc<Vec<WrappedLine>>;

/// What the field tells whoever owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorEvent {
	/// The text changed. The owner reads [`Editor::text`] and stores it.
	Changed,
	/// Enter, in a field where Enter means send.
	Submit,
}

/// A wrapped, growable text field.
pub struct Editor {
	focus:       FocusHandle,
	text:        SharedString,
	/// Byte offsets, `start <= end` always. Which end the caret is at is
	/// [`Editor::reversed`], so a selection extended leftward keeps its anchor.
	selection:   Range<usize>,
	reversed:    bool,
	/// The IME's in-progress composition, underlined while it exists.
	marked:      Option<Range<usize>>,
	placeholder: SharedString,
	/// Whether Enter inserts a line or submits.
	multiline:   bool,
	/// The keymap context this field dispatches in. The palette's field uses
	/// its own, so up, down and enter reach the list rather than the caret.
	context:     &'static str,
	/// The height the field takes when empty, and the height past which it
	/// stops growing and starts scrolling.
	min_height:  Pixels,
	max_height:  Pixels,
	/// This frame's shaping, written by the element, read by the mouse and the
	/// IME so both answer in the coordinates the text was drawn in.
	shaped:      Option<Shaped>,
	dragging:    bool,
	focused:     bool,
	caret_on:    bool,
	scroll:      Pixels,
	/// Dropping this stops the blink.
	_blink:      Task<()>,
}

/// Where the text ended up on screen.
struct Shaped {
	lines:       Lines,
	line_height: Pixels,
	bounds:      Bounds<Pixels>,
	scroll:      Pixels,
}

/// Everything shaping needs from the field, taken by value so the shaping call
/// does not hold a borrow of the app.
struct ShapeInput {
	display:     SharedString,
	marked:      Option<Range<usize>>,
	placeholder: bool,
}

impl Editor {
	pub fn new(
		placeholder: impl Into<SharedString>,
		multiline: bool,
		cx: &mut Context<Self>,
	) -> Self {
		let blink = cx.spawn(async move |this, cx| {
			loop {
				cx.background_executor().timer(BLINK).await;
				let alive = this
					.update(cx, |editor, cx| {
						if editor.focused {
							editor.caret_on = !editor.caret_on;
							cx.notify();
						}
					})
					.is_ok();
				if !alive {
					break;
				}
			}
		});

		Editor {
			focus: cx.focus_handle(),
			text: SharedString::default(),
			selection: 0..0,
			reversed: false,
			marked: None,
			placeholder: placeholder.into(),
			multiline,
			context: if multiline {
				"MultilineEditor"
			} else {
				"Editor"
			},
			min_height: px(20.0),
			max_height: px(240.0),
			shaped: None,
			dragging: false,
			focused: false,
			caret_on: true,
			scroll: px(0.0),
			_blink: blink,
		}
	}

	/// How tall the field is when empty and how tall it may grow.
	pub fn heights(mut self, min: f32, max: f32) -> Self {
		self.min_height = px(min);
		self.max_height = px(max);
		self
	}

	/// Dispatch in a named keymap context instead of the default.
	pub fn context(mut self, context: &'static str) -> Self {
		self.context = context;
		self
	}

	pub fn text(&self) -> &str {
		&self.text
	}

	/// The caret, as a byte offset.
	pub fn caret(&self) -> usize {
		if self.reversed {
			self.selection.start
		} else {
			self.selection.end
		}
	}

	/// Replace the whole text and put the caret at `caret`, clamped.
	///
	/// Setting the text it already holds does nothing, so a render that pushes
	/// the model's value every frame does not fight the caret.
	pub fn set_text(&mut self, text: &str, caret: usize, cx: &mut Context<Self>) {
		if self.text == text {
			return;
		}
		self.text = SharedString::from(text.to_owned());
		let caret = text::clamp(&self.text, caret);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.scroll = px(0.0);
		cx.notify();
	}

	pub fn clear(&mut self, cx: &mut Context<Self>) {
		self.text = SharedString::default();
		self.selection = 0..0;
		self.reversed = false;
		self.marked = None;
		self.scroll = px(0.0);
		cx.notify();
	}

	/// Put the keyboard in a field.
	///
	/// Associated rather than a method: `field.read(cx)` borrows the app, and
	/// focusing needs it mutably, so every caller would have to name the handle
	/// itself to get out of the borrow.
	pub fn focus(field: &Entity<Editor>, window: &mut Window, cx: &mut App) {
		let handle = field.read(cx).focus.clone();
		window.focus(&handle, cx);
	}

	/// Whether this field holds the keyboard.
	pub fn holds_keyboard(field: &Entity<Editor>, window: &Window, cx: &App) -> bool {
		field.read(cx).focus.is_focused(window)
	}

	fn shape_input(&self) -> ShapeInput {
		let placeholder = self.text.is_empty();
		ShapeInput {
			display: if placeholder {
				self.placeholder.clone()
			} else {
				self.text.clone()
			},
			marked: self.marked.clone(),
			placeholder,
		}
	}

	fn edited(&mut self, cx: &mut Context<Self>) {
		self.caret_on = true;
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	fn moved(&mut self, cx: &mut Context<Self>) {
		self.caret_on = true;
		cx.notify();
	}

	fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
		let offset = text::clamp(&self.text, offset);
		self.selection = offset..offset;
		self.reversed = false;
		self.moved(cx);
	}

	fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
		let offset = text::clamp(&self.text, offset);
		if self.reversed {
			self.selection.start = offset;
		} else {
			self.selection.end = offset;
		}
		if self.selection.end < self.selection.start {
			self.reversed = !self.reversed;
			self.selection = self.selection.end..self.selection.start;
		}
		self.moved(cx);
	}

	fn replace(&mut self, range: Range<usize>, with: &str, cx: &mut Context<Self>) {
		let (text, caret) = text::replace(&self.text, range, with);
		self.text = SharedString::from(text);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.edited(cx);
	}

	fn selected_range(&self) -> Range<usize> {
		if self.selection.is_empty() {
			self.caret()..self.caret()
		} else {
			self.selection.clone()
		}
	}

	// Movement.

	fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let to = text::previous_boundary(&self.text, self.caret());
			self.move_to(to, cx);
		} else {
			self.move_to(self.selection.start, cx);
		}
	}

	fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let to = text::next_boundary(&self.text, self.caret());
			self.move_to(to, cx);
		} else {
			self.move_to(self.selection.end, cx);
		}
	}

	fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_left(&self.text, self.caret());
		self.move_to(to, cx);
	}

	fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_right(&self.text, self.caret());
		self.move_to(to, cx);
	}

	fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(-1).unwrap_or(0);
		self.move_to(to, cx);
	}

	fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(1).unwrap_or(self.text.len());
		self.move_to(to, cx);
	}

	fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(0, |row| row.0);
		self.move_to(to, cx);
	}

	fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		self.move_to(to, cx);
	}

	fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
		self.move_to(0, cx);
	}

	fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
		let end = self.text.len();
		self.move_to(end, cx);
	}

	// Selection.

	fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::previous_boundary(&self.text, self.caret());
		self.select_to(to, cx);
	}

	fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::next_boundary(&self.text, self.caret());
		self.select_to(to, cx);
	}

	fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_left(&self.text, self.caret());
		self.select_to(to, cx);
	}

	fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_right(&self.text, self.caret());
		self.select_to(to, cx);
	}

	fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(-1).unwrap_or(0);
		self.select_to(to, cx);
	}

	fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(1).unwrap_or(self.text.len());
		self.select_to(to, cx);
	}

	fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(0, |row| row.0);
		self.select_to(to, cx);
	}

	fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		self.select_to(to, cx);
	}

	fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
		self.selection = 0..self.text.len();
		self.reversed = false;
		self.moved(cx);
	}

	// Deletion.

	fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let from = text::previous_boundary(&self.text, self.caret());
			if from == self.caret() {
				return;
			}
			self.replace(from..self.caret(), "", cx);
		} else {
			self.replace(self.selection.clone(), "", cx);
		}
	}

	fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let to = text::next_boundary(&self.text, self.caret());
			if to == self.caret() {
				return;
			}
			self.replace(self.caret()..to, "", cx);
		} else {
			self.replace(self.selection.clone(), "", cx);
		}
	}

	fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
		if !self.selection.is_empty() {
			self.replace(self.selection.clone(), "", cx);
			return;
		}
		let from = text::word_left(&self.text, self.caret());
		if from == self.caret() {
			return;
		}
		self.replace(from..self.caret(), "", cx);
	}

	fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
		if !self.selection.is_empty() {
			self.replace(self.selection.clone(), "", cx);
			return;
		}
		let to = text::word_right(&self.text, self.caret());
		if to == self.caret() {
			return;
		}
		self.replace(self.caret()..to, "", cx);
	}

	fn delete_to_line_end(&mut self, _: &DeleteToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		if to == self.caret() {
			return;
		}
		self.replace(self.caret()..to, "", cx);
	}

	// Text in and out.

	fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
		if !self.multiline {
			return;
		}
		let range = self.selected_range();
		self.replace(range, "\n", cx);
	}

	fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
		cx.emit(EditorEvent::Submit);
	}

	fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
		let Some(pasted) = cx.read_from_clipboard().and_then(|item| item.text()) else {
			return;
		};
		let pasted = if self.multiline {
			pasted.replace("\r\n", "\n").replace('\r', "\n")
		} else {
			pasted.replace(['\n', '\r'], " ")
		};
		let range = self.selected_range();
		self.replace(range, &pasted, cx);
	}

	fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			return;
		}
		let selected = self.text[self.selection.clone()].to_owned();
		cx.write_to_clipboard(ClipboardItem::new_string(selected));
	}

	fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			return;
		}
		let selected = self.text[self.selection.clone()].to_owned();
		cx.write_to_clipboard(ClipboardItem::new_string(selected));
		self.replace(self.selection.clone(), "", cx);
	}

	fn show_character_palette(
		&mut self,
		_: &ShowCharacterPalette,
		window: &mut Window,
		_: &mut Context<Self>,
	) {
		window.show_character_palette();
	}

	// Mouse.

	fn on_mouse_down(
		&mut self,
		event: &MouseDownEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		// A click into a field is how a pointer asks for the keyboard. Without
		// this the caret moves and the typing goes nowhere.
		window.focus(&self.focus, cx);
		self.dragging = true;
		let offset = self.offset_at(event.position);
		if event.modifiers.shift {
			self.select_to(offset, cx);
		} else if event.click_count > 1 {
			let (from, to) = text::word_at(&self.text, offset);
			self.selection = from..to;
			self.reversed = false;
			self.moved(cx);
		} else {
			self.move_to(offset, cx);
		}
	}

	fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
		self.dragging = false;
	}

	fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
		if self.dragging {
			let offset = self.offset_at(event.position);
			self.select_to(offset, cx);
		}
	}

	fn on_scroll(&mut self, event: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
		let Some(shaped) = self.shaped.as_ref() else {
			return;
		};
		let content = shaped.line_height * self.visual_rows() as f32;
		let overflow = (content - shaped.bounds.size.height).max(px(0.0));
		if overflow <= px(0.0) {
			return;
		}
		let delta = event.delta.pixel_delta(shaped.line_height).y;
		self.scroll = (self.scroll - delta).clamp(px(0.0), overflow);
		window.refresh();
		cx.notify();
	}

	// Geometry, answered from this frame's shaping.

	fn visual_rows(&self) -> usize {
		self
			.shaped
			.as_ref()
			.map(|shaped| rows_in(&shaped.lines))
			.unwrap_or(1)
	}

	/// The byte offset nearest a window-space point.
	fn offset_at(&self, position: Point<Pixels>) -> usize {
		let Some(shaped) = self.shaped.as_ref() else {
			return self.caret();
		};
		let local = point(
			position.x - shaped.bounds.origin.x,
			position.y - shaped.bounds.origin.y + shaped.scroll,
		);
		if local.y < px(0.0) {
			return 0;
		}
		let last = shaped.lines.len().saturating_sub(1);
		let mut start = 0;
		let mut top = px(0.0);
		for (index, line) in shaped.lines.iter().enumerate() {
			let height = shaped.line_height * (line.wrap_boundaries().len() + 1) as f32;
			if local.y < top + height || index == last {
				let inside = point(local.x, (local.y - top).max(px(0.0)));
				let within = line
					.closest_index_for_position(inside, shaped.line_height)
					.unwrap_or_else(|fallback| fallback);
				return start + within.min(line.len());
			}
			top += height;
			start += line.len() + 1;
		}
		self.text.len()
	}

	/// Where a byte offset is, in field-local coordinates before scrolling.
	fn position_of(&self, offset: usize) -> Option<Point<Pixels>> {
		let shaped = self.shaped.as_ref()?;
		let mut start = 0;
		let mut top = px(0.0);
		for line in shaped.lines.iter() {
			let end = start + line.len();
			if offset <= end {
				let local = line.position_for_index(offset - start, shaped.line_height)?;
				return Some(point(local.x, local.y + top));
			}
			top += shaped.line_height * (line.wrap_boundaries().len() + 1) as f32;
			start = end + 1;
		}
		None
	}

	/// The offset one visual row above or below the caret, at the same x.
	fn vertical(&self, rows: i32) -> Option<usize> {
		let shaped = self.shaped.as_ref()?;
		let at = self.position_of(self.caret())?;
		let target_y = at.y + shaped.line_height * rows as f32;
		if target_y < px(0.0) {
			return None;
		}
		let offset = self.offset_at(point(
			at.x + shaped.bounds.origin.x,
			target_y + shaped.bounds.origin.y - shaped.scroll,
		));
		(offset != self.caret()).then_some(offset)
	}

	/// The byte range of the visual row the caret is on.
	fn row_bounds(&self) -> Option<(usize, usize)> {
		let shaped = self.shaped.as_ref()?;
		let caret = self.caret();
		let mut start = 0;
		for line in shaped.lines.iter() {
			let end = start + line.len();
			if caret <= end {
				let mut row = (start, end);
				for (from, to) in rows_of(line, start) {
					if caret <= to {
						row = (from, to);
						break;
					}
				}
				return Some(row);
			}
			start = end + 1;
		}
		None
	}

	// utf16, which is what a platform IME counts in.

	fn to_utf16(&self, range: &Range<usize>) -> Range<usize> {
		text::offset_to_utf16(&self.text, range.start)..text::offset_to_utf16(&self.text, range.end)
	}

	fn to_offsets(&self, range: &Range<usize>) -> Range<usize> {
		text::offset_from_utf16(&self.text, range.start)
			..text::offset_from_utf16(&self.text, range.end)
	}
}

impl EventEmitter<EditorEvent> for Editor {}

impl Focusable for Editor {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl EntityInputHandler for Editor {
	fn text_for_range(
		&mut self,
		range_utf16: Range<usize>,
		actual: &mut Option<Range<usize>>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<String> {
		let range = self.to_offsets(&range_utf16);
		actual.replace(self.to_utf16(&range));
		Some(self.text[range].to_owned())
	}

	fn selected_text_range(
		&mut self,
		_ignore_disabled: bool,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<UTF16Selection> {
		Some(UTF16Selection { range: self.to_utf16(&self.selection), reversed: self.reversed })
	}

	fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
		self.marked.as_ref().map(|range| self.to_utf16(range))
	}

	fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
		self.marked = None;
	}

	fn replace_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let range = range_utf16
			.as_ref()
			.map(|range| self.to_offsets(range))
			.or_else(|| self.marked.clone())
			.unwrap_or_else(|| self.selection.clone());
		let new_text = if self.multiline {
			new_text.to_owned()
		} else {
			new_text.replace(['\n', '\r'], " ")
		};
		self.replace(range, &new_text, cx);
	}

	fn replace_and_mark_text_in_range(
		&mut self,
		range_utf16: Option<Range<usize>>,
		new_text: &str,
		new_selection_utf16: Option<Range<usize>>,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let range = range_utf16
			.as_ref()
			.map(|range| self.to_offsets(range))
			.or_else(|| self.marked.clone())
			.unwrap_or_else(|| self.selection.clone());

		let (text, caret) = text::replace(&self.text, range.clone(), new_text);
		let start = text::clamp(&text, range.start);
		self.text = SharedString::from(text);
		self.marked = (!new_text.is_empty()).then(|| start..start + new_text.len());
		self.selection = match new_selection_utf16.as_ref() {
			Some(selected) => {
				let selected = self.to_offsets(selected);
				let from = text::clamp(&self.text, start + selected.start);
				let to = text::clamp(&self.text, start + selected.end);
				from.min(to)..to.max(from)
			},
			None => caret..caret,
		};
		self.reversed = false;
		self.edited(cx);
	}

	fn bounds_for_range(
		&mut self,
		range_utf16: Range<usize>,
		element_bounds: Bounds<Pixels>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<Bounds<Pixels>> {
		let line_height = self.shaped.as_ref()?.line_height;
		let scroll = self.shaped.as_ref()?.scroll;
		let range = self.to_offsets(&range_utf16);
		let start = self.position_of(range.start)?;
		let end = self.position_of(range.end).unwrap_or(start);
		Some(Bounds::from_corners(
			point(element_bounds.origin.x + start.x, element_bounds.origin.y + start.y - scroll),
			point(
				element_bounds.origin.x + end.x,
				element_bounds.origin.y + end.y + line_height - scroll,
			),
		))
	}

	fn character_index_for_point(
		&mut self,
		point: Point<Pixels>,
		_: &mut Window,
		_: &mut Context<Self>,
	) -> Option<usize> {
		let offset = self.offset_at(point);
		Some(text::offset_to_utf16(&self.text, offset))
	}
}

impl Render for Editor {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.key_context(self.context)
			.track_focus(&self.focus)
			.cursor(CursorStyle::IBeam)
			.on_action(cx.listener(Self::left))
			.on_action(cx.listener(Self::right))
			.on_action(cx.listener(Self::up))
			.on_action(cx.listener(Self::down))
			.on_action(cx.listener(Self::word_left))
			.on_action(cx.listener(Self::word_right))
			.on_action(cx.listener(Self::home))
			.on_action(cx.listener(Self::end))
			.on_action(cx.listener(Self::doc_start))
			.on_action(cx.listener(Self::doc_end))
			.on_action(cx.listener(Self::select_left))
			.on_action(cx.listener(Self::select_right))
			.on_action(cx.listener(Self::select_up))
			.on_action(cx.listener(Self::select_down))
			.on_action(cx.listener(Self::select_word_left))
			.on_action(cx.listener(Self::select_word_right))
			.on_action(cx.listener(Self::select_home))
			.on_action(cx.listener(Self::select_end))
			.on_action(cx.listener(Self::select_all))
			.on_action(cx.listener(Self::backspace))
			.on_action(cx.listener(Self::delete))
			.on_action(cx.listener(Self::delete_word_left))
			.on_action(cx.listener(Self::delete_word_right))
			.on_action(cx.listener(Self::delete_to_line_end))
			.on_action(cx.listener(Self::newline))
			.on_action(cx.listener(Self::submit))
			.on_action(cx.listener(Self::paste))
			.on_action(cx.listener(Self::copy))
			.on_action(cx.listener(Self::cut))
			.on_action(cx.listener(Self::show_character_palette))
			.on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
			.on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
			.on_mouse_move(cx.listener(Self::on_mouse_move))
			.on_scroll_wheel(cx.listener(Self::on_scroll))
			.w_full()
			.child(EditorElement { editor: cx.entity() })
	}
}

/// The element that shapes, measures and draws one [`Editor`].
struct EditorElement {
	editor: Entity<Editor>,
}

struct Painted {
	lines:  Lines,
	quads:  Vec<PaintQuad>,
	caret:  Option<PaintQuad>,
	scroll: Pixels,
}

impl IntoElement for EditorElement {
	type Element = Self;

	fn into_element(self) -> Self::Element {
		self
	}
}

/// How many visual rows a shaping came to.
fn rows_in(lines: &[WrappedLine]) -> usize {
	lines
		.iter()
		.map(|line| line.wrap_boundaries().len() + 1)
		.sum::<usize>()
		.max(1)
}

/// Shape one field's text at a width. Called by the measure pass and again by
/// the paint pass; gpui's line layout cache is what makes that cheap.
fn shape(input: &ShapeInput, theme: &Theme, width: Pixels, window: &mut Window) -> Lines {
	let style = window.text_style();
	let font_size = style.font_size.to_pixels(window.rem_size());
	let color = if input.placeholder {
		theme.text_faint
	} else {
		style.color
	};

	let base = TextRun {
		len: input.display.len(),
		font: style.font(),
		color,
		background_color: None,
		underline: None,
		strikethrough: None,
	};
	let runs = match input.marked.as_ref() {
		Some(marked) if !input.placeholder && marked.end <= input.display.len() => vec![
			TextRun { len: marked.start, ..base.clone() },
			TextRun {
				len: marked.end - marked.start,
				underline: Some(UnderlineStyle {
					color:     Some(color),
					thickness: px(1.0),
					wavy:      false,
				}),
				..base.clone()
			},
			TextRun { len: input.display.len() - marked.end, ..base },
		]
		.into_iter()
		.filter(|run| run.len > 0)
		.collect(),
		_ => vec![base],
	};

	let lines = window
		.text_system()
		.shape_text(input.display.clone(), font_size, &runs, Some(width), None)
		.unwrap_or_default();
	Arc::new(lines.into_vec())
}

impl Element for EditorElement {
	type PrepaintState = Painted;
	type RequestLayoutState = ();

	fn id(&self) -> Option<ElementId> {
		None
	}

	fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
		None
	}

	fn request_layout(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		window: &mut Window,
		cx: &mut App,
	) -> (LayoutId, Self::RequestLayoutState) {
		let mut style = Style::default();
		style.size.width = relative(1.0).into();

		let editor = self.editor.clone();
		let theme = Theme::get(cx);
		let id = window.request_measured_layout(style, move |known, available, window, cx| {
			let width = known.width.unwrap_or(match available.width {
				gpui::AvailableSpace::Definite(width) => width,
				_ => px(320.0),
			});
			let (input, min, max) = {
				let editor = editor.read(cx);
				(editor.shape_input(), editor.min_height, editor.max_height)
			};
			let lines = shape(&input, &theme, width, window);
			let height = (window.line_height() * rows_in(&lines) as f32).clamp(min, max);
			Size { width, height }
		});
		(id, ())
	}

	fn prepaint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		window: &mut Window,
		cx: &mut App,
	) -> Self::PrepaintState {
		let theme = Theme::get(cx);
		let line_height = window.line_height();
		let input = self.editor.read(cx).shape_input();
		let lines = shape(&input, &theme, bounds.size.width, window);

		let content = line_height * rows_in(&lines) as f32;
		let overflow = (content - bounds.size.height).max(px(0.0));
		let focused = self.editor.read(cx).focus.is_focused(window);

		// The entity answers geometry out of what was shaped, so it gets this
		// frame's lines before anything asks it where the caret is.
		let (selection, caret_offset, caret_on) = self.editor.update(cx, |editor, _| {
			editor.focused = focused;
			editor.scroll = editor.scroll.clamp(px(0.0), overflow);
			editor.shaped =
				Some(Shaped { lines: lines.clone(), line_height, bounds, scroll: editor.scroll });
			(editor.selection.clone(), editor.caret(), editor.caret_on && focused)
		});

		let caret_at = self.editor.read(cx).position_of(caret_offset);
		let scroll = self.editor.update(cx, |editor, _| {
			if let Some(at) = caret_at {
				if at.y < editor.scroll {
					editor.scroll = at.y;
				} else if at.y + line_height > editor.scroll + bounds.size.height {
					editor.scroll = at.y + line_height - bounds.size.height;
				}
				editor.scroll = editor.scroll.clamp(px(0.0), overflow);
			}
			if let Some(shaped) = editor.shaped.as_mut() {
				shaped.scroll = editor.scroll;
			}
			editor.scroll
		});

		// One quad per visual row the selection touches.
		let mut quads = Vec::new();
		if !selection.is_empty() && !input.placeholder {
			let editor = self.editor.read(cx);
			let mut start = 0;
			for line in lines.iter() {
				let end = start + line.len();
				if selection.end >= start && selection.start <= end {
					for (row_start, row_end) in rows_of(line, start) {
						let from = selection.start.max(row_start);
						let to = selection.end.min(row_end);
						if from >= to {
							continue;
						}
						let Some(a) = editor.position_of(from) else {
							continue;
						};
						let b = editor
							.position_of(to)
							.filter(|b| b.y == a.y)
							.unwrap_or(point(line.width(), a.y));
						quads.push(fill(
							Bounds::new(
								point(bounds.origin.x + a.x, bounds.origin.y + a.y - scroll),
								size((b.x - a.x).max(px(2.0)), line_height),
							),
							theme.accent.opacity(0.28),
						));
					}
				}
				start = end + 1;
			}
		}

		let caret = (caret_on && selection.is_empty())
			.then_some(caret_at)
			.flatten()
			.map(|at| {
				fill(
					Bounds::new(
						point(bounds.origin.x + at.x, bounds.origin.y + at.y - scroll + px(1.0)),
						size(px(1.5), line_height - px(2.0)),
					),
					theme.accent,
				)
			});

		Painted { lines, quads, caret, scroll }
	}

	fn paint(
		&mut self,
		_: Option<&GlobalElementId>,
		_: Option<&InspectorElementId>,
		bounds: Bounds<Pixels>,
		_: &mut Self::RequestLayoutState,
		painted: &mut Self::PrepaintState,
		window: &mut Window,
		cx: &mut App,
	) {
		let focus = self.editor.read(cx).focus.clone();
		window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);

		let line_height = window.line_height();
		let scroll = painted.scroll;
		let lines = painted.lines.clone();
		let quads: Vec<PaintQuad> = painted.quads.drain(..).collect();
		let caret = painted.caret.take();

		window.with_content_mask(Some(ContentMask { bounds }), |window| {
			for quad in quads {
				window.paint_quad(quad);
			}

			let mut top = bounds.origin.y - scroll;
			for line in lines.iter() {
				let _ = line.paint(
					point(bounds.origin.x, top),
					line_height,
					TextAlign::Left,
					None,
					window,
					cx,
				);
				top += line_height * (line.wrap_boundaries().len() + 1) as f32;
			}

			if let Some(caret) = caret {
				window.paint_quad(caret);
			}
		});
	}
}

/// The byte ranges of one logical line's visual rows, offset into the document.
///
/// A wrap boundary is reported as a run and glyph index, and the byte offset it
/// sits at is that glyph's index in the original text. Rows are half open and
/// abut: the boundary byte starts the next row.
fn rows_of(line: &WrappedLine, line_start: usize) -> Vec<(usize, usize)> {
	let mut rows = Vec::with_capacity(line.wrap_boundaries().len() + 1);
	let mut start = line_start;
	for boundary in line.wrap_boundaries() {
		let run = &line.runs()[boundary.run_ix];
		let end = line_start + run.glyphs[boundary.glyph_ix].index;
		rows.push((start, end));
		start = end;
	}
	rows.push((start, line_start + line.len()));
	rows
}

/// Editing over `&str`, with no window and no state.
///
/// Every offset here is a byte offset, every returned offset is on a character
/// boundary, and every function is total: an offset past the end or inside a
/// multi-byte character is clamped rather than a panic, because these offsets
/// arrive from a mouse, an IME and a model, and none of the three can be
/// trusted to know where a grapheme starts.
pub mod text {
	use std::ops::Range;

	use unicode_segmentation::UnicodeSegmentation;

	/// The nearest character boundary at or before `offset`, within the string.
	pub fn clamp(text: &str, offset: usize) -> usize {
		let mut offset = offset.min(text.len());
		while offset > 0 && !text.is_char_boundary(offset) {
			offset -= 1;
		}
		offset
	}

	/// The grapheme boundary before `offset`, or 0.
	pub fn previous_boundary(text: &str, offset: usize) -> usize {
		let offset = clamp(text, offset);
		text
			.grapheme_indices(true)
			.rev()
			.find_map(|(at, _)| (at < offset).then_some(at))
			.unwrap_or(0)
	}

	/// The grapheme boundary after `offset`, or the end.
	pub fn next_boundary(text: &str, offset: usize) -> usize {
		let offset = clamp(text, offset);
		text
			.grapheme_indices(true)
			.find_map(|(at, _)| (at > offset).then_some(at))
			.unwrap_or(text.len())
	}

	/// The start of the word before `offset`, skipping the whitespace between.
	pub fn word_left(text: &str, offset: usize) -> usize {
		let offset = clamp(text, offset);
		let mut candidate = 0;
		for (at, word) in text.split_word_bound_indices() {
			if at >= offset {
				break;
			}
			if !word.trim().is_empty() {
				candidate = at;
			}
		}
		candidate
	}

	/// The end of the word after `offset`, skipping the whitespace between.
	pub fn word_right(text: &str, offset: usize) -> usize {
		let offset = clamp(text, offset);
		for (at, word) in text.split_word_bound_indices() {
			let end = at + word.len();
			if end > offset && !word.trim().is_empty() {
				return end;
			}
		}
		text.len()
	}

	/// The word containing `offset`, for a double click.
	pub fn word_at(text: &str, offset: usize) -> (usize, usize) {
		let offset = clamp(text, offset);
		for (at, word) in text.split_word_bound_indices() {
			let end = at + word.len();
			if offset >= at && offset <= end && !word.trim().is_empty() {
				return (at, end);
			}
		}
		(offset, offset)
	}

	/// `text` with `range` replaced, and where the caret lands.
	pub fn replace(text: &str, range: Range<usize>, with: &str) -> (String, usize) {
		let start = clamp(text, range.start);
		let end = clamp(text, range.end).max(start);
		let mut out = String::with_capacity(text.len() - (end - start) + with.len());
		out.push_str(&text[..start]);
		out.push_str(with);
		out.push_str(&text[end..]);
		(out, start + with.len())
	}

	/// A byte offset as a utf16 offset, which is what a platform IME counts in.
	pub fn offset_to_utf16(text: &str, offset: usize) -> usize {
		let offset = clamp(text, offset);
		text[..offset].chars().map(char::len_utf16).sum()
	}

	/// A utf16 offset back to a byte offset.
	pub fn offset_from_utf16(text: &str, offset: usize) -> usize {
		let mut utf16 = 0;
		let mut bytes = 0;
		for character in text.chars() {
			if utf16 >= offset {
				break;
			}
			utf16 += character.len_utf16();
			bytes += character.len_utf8();
		}
		bytes
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An editor's defects are all in the offsets, and most of them are a panic
	//! on somebody's keyboard rather than a wrong pixel: a caret stepping into
	//! the middle of a multi-byte character, a word jump that stalls on
	//! whitespace and never terminates under a held key, a replacement range
	//! arriving from an IME with its ends the wrong way round, a utf16 offset
	//! read as bytes. This suite drives the arithmetic with text that has
	//! multi-byte characters, a combining mark and an emoji in it, because ASCII
	//! cannot fail the way the reports do.
	//!
	//! WHAT IT DOES NOT CATCH. Anything that needs a window: wrapping, the
	//! caret's position on screen, hit testing, the scroll that keeps the caret
	//! visible. Those need a shaped line, which needs a font, which needs a
	//! platform. The window's own run covers them.

	use super::text::*;

	/// A combining acute accent, a two-byte character, and an emoji whose
	/// grapheme is several code points.
	const MIXED: &str = "cafe\u{301} über 👩‍🚀 end";

	#[test]
	fn an_offset_inside_a_character_is_pulled_back_to_its_start() {
		let u = MIXED.find('ü').unwrap();
		assert_eq!(clamp(MIXED, u + 1), u, "an offset inside a two-byte character was kept");
		assert_eq!(clamp(MIXED, 0), 0);
		assert_eq!(clamp(MIXED, usize::MAX), MIXED.len());
	}

	#[test]
	fn stepping_never_lands_inside_a_character_and_terminates_at_both_ends() {
		let mut at = 0;
		let mut steps = 0;
		while at < MIXED.len() {
			let next = next_boundary(MIXED, at);
			assert!(next > at, "next_boundary stalled at {at}");
			assert!(MIXED.is_char_boundary(next), "landed inside a character at {next}");
			at = next;
			steps += 1;
			assert!(steps < 100, "walking forward did not terminate");
		}
		assert_eq!(at, MIXED.len());

		let mut steps = 0;
		while at > 0 {
			let previous = previous_boundary(MIXED, at);
			assert!(previous < at, "previous_boundary stalled at {at}");
			assert!(MIXED.is_char_boundary(previous));
			at = previous;
			steps += 1;
			assert!(steps < 100, "walking back did not terminate");
		}
		assert_eq!(at, 0);
	}

	#[test]
	fn one_step_crosses_a_whole_grapheme_rather_than_one_code_point() {
		// "cafe" then a combining accent: stepping right from before the "e"
		// has to clear both, or backspace leaves a bare accent behind.
		let e = MIXED.find('e').unwrap();
		let after = next_boundary(MIXED, e);
		assert_eq!(&MIXED[e..after], "e\u{301}");

		let emoji = MIXED.find('👩').unwrap();
		let after = next_boundary(MIXED, emoji);
		assert_eq!(&MIXED[emoji..after], "👩‍🚀");
	}

	#[test]
	fn a_word_jump_skips_the_space_and_stops_on_the_word() {
		let text = "one  two three";
		assert_eq!(word_right(text, 0), 3, "did not stop at the end of the first word");
		assert_eq!(word_right(text, 3), 8, "did not skip the double space");
		assert_eq!(word_left(text, 8), 5);
		assert_eq!(word_left(text, 0), 0);
		assert_eq!(word_right(text, text.len()), text.len());
	}

	#[test]
	fn a_word_jump_over_only_whitespace_terminates_at_the_edge() {
		// A held ctrl-left in a field of spaces has to reach 0 and stay there.
		let text = "    ";
		let mut at = text.len();
		for _ in 0..10 {
			at = word_left(text, at);
		}
		assert_eq!(at, 0);

		let mut at = 0;
		for _ in 0..10 {
			at = word_right(text, at);
		}
		assert_eq!(at, text.len());
	}

	#[test]
	fn a_double_click_selects_the_word_under_it_and_nothing_in_whitespace() {
		let text = "send the frame";
		assert_eq!(word_at(text, 6), (5, 8));
		assert_eq!(word_at(text, 5), (5, 8), "a click on a word's first byte missed it");
		let (start, end) = word_at("a  b", 2);
		assert_eq!(start, end, "a click in whitespace selected something");
	}

	#[test]
	fn replacing_a_range_puts_the_caret_after_what_was_inserted() {
		let (text, caret) = replace("hello world", 6..11, "there");
		assert_eq!(text, "hello there");
		assert_eq!(caret, 11);

		let (text, caret) = replace("abc", 1..1, "XY");
		assert_eq!(text, "aXYbc");
		assert_eq!(caret, 3);

		let (text, caret) = replace("abc", 1..3, "");
		assert_eq!(text, "a");
		assert_eq!(caret, 1);
	}

	#[test]
	fn a_replacement_range_that_is_backwards_or_past_the_end_does_not_panic() {
		// Both arrive in practice: the first from an IME, the second from an
		// offset held across an edit that shortened the text.
		let (text, caret) = replace("abc", std::ops::Range { start: 3, end: 1 }, "Z");
		assert_eq!(text, "abcZ");
		assert_eq!(caret, 4);

		let (text, _) = replace("abc", 9..12, "Z");
		assert_eq!(text, "abcZ");

		// Inside a multi-byte character, which is a panic if not clamped.
		let (text, _) = replace("über", 1..2, "-");
		assert_eq!(text, "-ber");
	}

	#[test]
	fn a_utf16_offset_round_trips_through_bytes_for_every_boundary() {
		let mut at = 0;
		while at <= MIXED.len() {
			if MIXED.is_char_boundary(at) {
				let utf16 = offset_to_utf16(MIXED, at);
				assert_eq!(
					offset_from_utf16(MIXED, utf16),
					at,
					"utf16 round trip lost byte offset {at}"
				);
			}
			at += 1;
		}
	}

	#[test]
	fn a_utf16_offset_counts_a_surrogate_pair_as_two_units() {
		// The astronaut is outside the basic plane, so each of its code points
		// is two utf16 units; a handler that counts characters reports a range
		// the platform then highlights in the wrong place.
		let emoji = MIXED.find('👩').unwrap();
		let after = next_boundary(MIXED, emoji);
		let units = offset_to_utf16(MIXED, after) - offset_to_utf16(MIXED, emoji);
		let chars = MIXED[emoji..after].chars().count();
		assert!(units > chars, "a surrogate pair was counted as one unit");
	}
}
