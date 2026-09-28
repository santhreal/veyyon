//! What each editor action, pointer event and clipboard command does.

use std::ops::Range;

use veyyon_gpui::{
	ClipboardItem, Context, MouseDownEvent, Pixels, Point, ScrollWheelEvent, Window,
};

use super::{EditKind, Editor, EditorEvent, EditorMode, Motion, Unit};
use crate::theme::size;

impl Editor {
	/// Applies a caret motion that is not vertical.
	pub(super) fn motion(&mut self, motion: Motion, extend: bool, cx: &mut Context<Self>) {
		self.marked = None;
		self.buffer.move_caret(motion, extend);
		self.moved(cx);
	}

	/// Moves one visual row up or down, keeping the goal column. Past the first
	/// or last row a plain motion reports history navigation and an extending
	/// motion selects to the start or end of the text.
	pub(super) fn vertical(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
		self.marked = None;
		let head = self.buffer.cursor();
		let target = if let Some(layout) = self.current_layout() {
			let row = layout.row_for_offset(head);
			let edge = if down { row + 1 >= layout.row_count() } else { row == 0 };
			if edge {
				None
			} else {
				let x = *self.goal_x.get_or_insert_with(|| layout.x_in_row(row, head));
				Some(layout.offset_in_row(if down { row + 1 } else { row - 1 }, x))
			}
		} else {
			let (line, _) = self.buffer.line_column(head);
			let edge = if down { line + 1 >= self.buffer.line_count() } else { line == 0 };
			if !edge {
				self.buffer.move_caret(if down { Motion::Down } else { Motion::Up }, extend);
				self.show_caret(cx);
				return;
			}
			None
		};
		match target {
			Some(offset) => {
				self.buffer.move_to(offset, extend);
				self.show_caret(cx);
			},
			None if extend => {
				self.buffer.move_to(if down { self.buffer.len() } else { 0 }, true);
				self.moved(cx);
			},
			None if down => cx.emit(EditorEvent::HistoryNext),
			None => cx.emit(EditorEvent::HistoryPrev),
		}
	}

	pub(super) fn select_all(&mut self, cx: &mut Context<Self>) {
		self.buffer.select_all();
		self.moved(cx);
	}

	/// Deletes the selection, or `unit` on one side of the caret.
	pub(super) fn delete(&mut self, backward: bool, unit: Unit, cx: &mut Context<Self>) {
		self.marked = None;
		let deleted = if backward {
			self.buffer.delete_backward(unit)
		} else {
			self.buffer.delete_forward(unit)
		};
		if deleted {
			self.changed(cx);
		}
	}

	pub(super) fn undo(&mut self, cx: &mut Context<Self>) {
		self.marked = None;
		if self.buffer.undo() {
			self.changed(cx);
		}
	}

	pub(super) fn redo(&mut self, cx: &mut Context<Self>) {
		self.marked = None;
		if self.buffer.redo() {
			self.changed(cx);
		}
	}

	/// Replaces the marked text, or else the selection, with `text`.
	pub(super) fn insert(&mut self, text: &str, kind: EditKind, cx: &mut Context<Self>) {
		let range = self.marked.take().unwrap_or_else(|| self.buffer.selection().range());
		self.replace_with(range, text, kind, cx);
	}

	/// Replaces `range` with `text`, line breaks normalized for the mode.
	pub(super) fn replace_with(
		&mut self,
		range: Range<usize>,
		text: &str,
		kind: EditKind,
		cx: &mut Context<Self>,
	) {
		self.marked = None;
		let text = self.sanitize(text);
		self.buffer.edit(range, &text, kind);
		self.changed(cx);
	}

	/// Copies the selection; does nothing while masked.
	pub(super) fn copy(&self, cx: &Context<Self>) {
		let selected = self.buffer.selected_text();
		if !self.masked && !selected.is_empty() {
			cx.write_to_clipboard(ClipboardItem::new_string(selected.to_owned()));
		}
	}

	/// Cuts the selection; does nothing while masked, so a secret neither
	/// reaches the clipboard nor leaves the field.
	pub(super) fn cut(&mut self, cx: &mut Context<Self>) {
		if self.masked || self.buffer.selection().is_empty() {
			return;
		}
		self.copy(cx);
		self.insert("", EditKind::Replace, cx);
	}

	pub(super) fn paste(&mut self, cx: &mut Context<Self>) {
		if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
			self.insert(&text, EditKind::Replace, cx);
		}
	}

	/// Enter, or Shift-Enter when `newline` is set.
	pub(super) fn enter(&mut self, newline: bool, cx: &mut Context<Self>) {
		match self.mode {
			EditorMode::MultiLine { submit_on_enter } if newline || !submit_on_enter => {
				self.insert("\n", EditKind::Replace, cx);
			},
			_ => cx.emit(EditorEvent::Submit),
		}
	}

	/// The text offset under a window position, from the last frame's layout.
	pub(super) fn offset_at(&self, position: Point<Pixels>) -> Option<usize> {
		let layout = self.layout.as_ref()?;
		let bounds = self.bounds?;
		if layout.placeholder {
			return Some(0);
		}
		Some(layout.offset_for_position(position - bounds.origin + self.scroll))
	}

	/// A primary press: one click places the caret (Shift extends), two select
	/// a word, three select a line. Drags extend from here.
	pub(super) fn mouse_down(
		&mut self,
		event: &MouseDownEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.focus_handle.focus(window, cx);
		let Some(offset) = self.offset_at(event.position) else {
			return;
		};
		self.marked = None;
		match event.click_count {
			2 => self.buffer.select_word_at(offset),
			count if count >= 3 => self.buffer.select_line_at(offset),
			_ => self.buffer.move_to(offset, event.modifiers.shift),
		}
		self.selecting = true;
		self.moved(cx);
	}

	/// Extends the selection to the text under a dragging pointer.
	pub(super) fn drag_to(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
		if let Some(offset) = self.offset_at(position)
			&& offset != self.buffer.cursor()
		{
			self.buffer.move_to(offset, true);
			self.moved(cx);
		}
	}

	/// Scrolls content that overflows the editor; a wheel event the editor
	/// cannot use reaches its ancestors.
	pub(super) fn scroll_wheel(
		&mut self,
		event: &ScrollWheelEvent,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let (Some(layout), Some(bounds)) = (self.layout.as_ref(), self.bounds) else {
			return;
		};
		let delta = event.delta.pixel_delta(layout.line_height);
		let before = self.scroll;
		if self.wraps() {
			let max = (layout.height() - bounds.size.height).max(Pixels::ZERO);
			self.scroll.y = (self.scroll.y - delta.y).max(Pixels::ZERO).min(max);
		} else {
			let max = (layout.width + size::CARET - bounds.size.width).max(Pixels::ZERO);
			let dx = if delta.x == Pixels::ZERO { delta.y } else { delta.x };
			self.scroll.x = (self.scroll.x - dx).max(Pixels::ZERO).min(max);
		}
		if self.scroll != before {
			self.autoscroll = false;
			cx.stop_propagation();
			cx.notify();
		}
	}
}
