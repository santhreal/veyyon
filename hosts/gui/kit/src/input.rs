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
mod actions;
mod editor;
mod element;
mod geometry;
mod ime;
pub mod keys;
mod pointer;
pub mod text;

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

impl EventEmitter<EditorEvent> for Editor {}

/// How many visual rows a shaping came to.
fn rows_in(lines: &[WrappedLine]) -> usize {
	lines
		.iter()
		.map(|line| line.wrap_boundaries().len() + 1)
		.sum::<usize>()
		.max(1)
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

#[cfg(test)]
mod tests;
