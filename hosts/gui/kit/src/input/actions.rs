//! One method per bound action: move, select, delete, newline, submit, and the
//! clipboard.
//!
//! Each is thin on purpose. The caret arithmetic is in [`super::text`], which
//! has no window and is where the tests are.

use super::*;

impl Editor {
	// Movement.

	pub(super) fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let to = text::previous_boundary(&self.text, self.caret());
			self.move_to(to, cx);
		} else {
			self.move_to(self.selection.start, cx);
		}
	}

	pub(super) fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
		if self.selection.is_empty() {
			let to = text::next_boundary(&self.text, self.caret());
			self.move_to(to, cx);
		} else {
			self.move_to(self.selection.end, cx);
		}
	}

	pub(super) fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_left(&self.text, self.caret());
		self.move_to(to, cx);
	}

	pub(super) fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::word_right(&self.text, self.caret());
		self.move_to(to, cx);
	}

	pub(super) fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(-1).unwrap_or(0);
		self.move_to(to, cx);
	}

	pub(super) fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(1).unwrap_or(self.text.len());
		self.move_to(to, cx);
	}

	pub(super) fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(0, |row| row.0);
		self.move_to(to, cx);
	}

	pub(super) fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		self.move_to(to, cx);
	}

	pub(super) fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
		self.move_to(0, cx);
	}

	pub(super) fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
		let end = self.text.len();
		self.move_to(end, cx);
	}

	// Selection.

	pub(super) fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::previous_boundary(&self.text, self.caret());
		self.select_to(to, cx);
	}

	pub(super) fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
		let to = text::next_boundary(&self.text, self.caret());
		self.select_to(to, cx);
	}

	pub(super) fn select_word_left(
		&mut self,
		_: &SelectWordLeft,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let to = text::word_left(&self.text, self.caret());
		self.select_to(to, cx);
	}

	pub(super) fn select_word_right(
		&mut self,
		_: &SelectWordRight,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let to = text::word_right(&self.text, self.caret());
		self.select_to(to, cx);
	}

	pub(super) fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(-1).unwrap_or(0);
		self.select_to(to, cx);
	}

	pub(super) fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.vertical(1).unwrap_or(self.text.len());
		self.select_to(to, cx);
	}

	pub(super) fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(0, |row| row.0);
		self.select_to(to, cx);
	}

	pub(super) fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		self.select_to(to, cx);
	}

	pub(super) fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
		self.selection = 0..self.text.len();
		self.reversed = false;
		self.moved(cx);
	}

	// Deletion.

	pub(super) fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
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

	pub(super) fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
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

	pub(super) fn delete_word_left(
		&mut self,
		_: &DeleteWordLeft,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
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

	pub(super) fn delete_word_right(
		&mut self,
		_: &DeleteWordRight,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
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

	pub(super) fn delete_to_line_end(
		&mut self,
		_: &DeleteToLineEnd,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		let to = self.row_bounds().map_or(self.text.len(), |row| row.1);
		if to == self.caret() {
			return;
		}
		self.replace(self.caret()..to, "", cx);
	}

	// Text in and out.

	pub(super) fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
		if !self.multiline {
			return;
		}
		let range = self.selected_range();
		self.replace(range, "\n", cx);
	}

	pub(super) fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
		cx.emit(EditorEvent::Submit);
	}

	pub(super) fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
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

	pub(super) fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
		if self.secret || self.selection.is_empty() {
			return;
		}
		let selected = self.text[self.selection.clone()].to_owned();
		cx.write_to_clipboard(ClipboardItem::new_string(selected));
	}

	pub(super) fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
		if self.secret || self.selection.is_empty() {
			return;
		}
		let selected = self.text[self.selection.clone()].to_owned();
		cx.write_to_clipboard(ClipboardItem::new_string(selected));
		self.replace(self.selection.clone(), "", cx);
	}

	pub(super) fn show_character_palette(
		&mut self,
		_: &ShowCharacterPalette,
		window: &mut Window,
		_: &mut Context<Self>,
	) {
		window.show_character_palette();
	}

	// Mouse.
}
