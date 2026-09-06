//! Action handlers for clipboard, enter/escape, and deletion in Editor view
//! (§8.25).

use std::time::Duration;

use veyyon_gpui::{ClipboardItem, Context, Task, Window};

use super::{
	Editor, EditorEvent, EditorMode,
	actions::{
		Backspace, Copy, Cut, Delete, DeleteToLineEnd, DeleteToLineStart, DeleteWordBackward,
		DeleteWordForward, Enter, Escape, Newline, Paste, Redo, SelectAll, Undo,
	},
};

impl Editor {
	#[expect(dead_code, reason = "cursor blink loop hook for focus")]
	pub(crate) fn start_blink(&mut self, cx: &mut Context<Self>) {
		self.cursor_visible = true;
		self.blink_task = cx.spawn(async move |this, cx| {
			loop {
				cx.background_executor()
					.timer(Duration::from_millis(500))
					.await;
				let res = this.update(cx, |editor, cx| {
					editor.cursor_visible = !editor.cursor_visible;
					cx.notify();
				});
				if res.is_err() {
					break;
				}
			}
		});
		cx.notify();
	}

	#[expect(dead_code, reason = "cursor blink loop hook for blur")]
	pub(crate) fn stop_blink(&mut self, _cx: &mut Context<Self>) {
		self.cursor_visible = false;
		self.blink_task = Task::ready(());
	}

	pub(crate) fn reset_blink(&mut self, cx: &mut Context<Self>) {
		self.cursor_visible = true;
		cx.notify();
	}

	pub(crate) fn select_all_action(
		&mut self,
		_: &SelectAll,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.select_all();
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn undo_action(&mut self, _: &Undo, _window: &mut Window, cx: &mut Context<Self>) {
		if self.buffer.undo() {
			self.marked_range = None;
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn redo_action(&mut self, _: &Redo, _window: &mut Window, cx: &mut Context<Self>) {
		if self.buffer.redo() {
			self.marked_range = None;
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn copy_action(&mut self, _: &Copy, _window: &mut Window, cx: &mut Context<Self>) {
		let selected = self.buffer.selected_text();
		if !selected.is_empty() {
			cx.write_to_clipboard(ClipboardItem::new_string(selected.to_string()));
		}
	}

	pub(crate) fn cut_action(&mut self, _: &Cut, _window: &mut Window, cx: &mut Context<Self>) {
		let selected = self.buffer.selected_text();
		if !selected.is_empty() {
			cx.write_to_clipboard(ClipboardItem::new_string(selected.to_string()));
			self.buffer.delete_backward();
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn paste_action(&mut self, _: &Paste, _window: &mut Window, cx: &mut Context<Self>) {
		let Some(item) = cx.read_from_clipboard() else {
			return;
		};
		let Some(text) = item.text() else {
			// An image or a set of files: not the editor's to insert, but
			// the owner may attach it (§5.4).
			if !item.entries().is_empty() {
				cx.emit(EditorEvent::PasteMedia(item));
			}
			return;
		};
		let clean = match self.mode {
			EditorMode::SingleLine => text.replace(['\r', '\n'], ""),
			EditorMode::Multiline { .. } => text.replace("\r\n", "\n"),
		};
		self.buffer.insert(&clean);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	pub(crate) fn newline_action(
		&mut self,
		_: &Newline,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match self.mode {
			EditorMode::SingleLine => {},
			EditorMode::Multiline { .. } => {
				self.buffer.insert("\n");
				self.goal_column = None;
				self.reset_blink(cx);
				cx.emit(EditorEvent::Changed);
				cx.notify();
			},
		}
	}

	pub(crate) fn enter_action(&mut self, _: &Enter, _window: &mut Window, cx: &mut Context<Self>) {
		match self.mode {
			EditorMode::SingleLine | EditorMode::Multiline { newline_on_enter: false } => {
				cx.emit(EditorEvent::Submit);
			},
			EditorMode::Multiline { newline_on_enter: true } => {
				self.buffer.insert("\n");
				self.goal_column = None;
				self.reset_blink(cx);
				cx.emit(EditorEvent::Changed);
				cx.notify();
			},
		}
	}

	#[expect(clippy::unused_self, reason = "gpui action handler signature requirement")]
	pub(crate) fn escape_action(
		&mut self,
		_: &Escape,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		cx.emit(EditorEvent::Escape);
	}

	pub(crate) fn backspace_action(
		&mut self,
		_: &Backspace,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_backward() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn delete_action(
		&mut self,
		_: &Delete,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_forward() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn delete_word_backward_action(
		&mut self,
		_: &DeleteWordBackward,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_word_backward() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn delete_word_forward_action(
		&mut self,
		_: &DeleteWordForward,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_word_forward() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn delete_to_line_start_action(
		&mut self,
		_: &DeleteToLineStart,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_to_line_start() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}

	pub(crate) fn delete_to_line_end_action(
		&mut self,
		_: &DeleteToLineEnd,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.buffer.delete_to_line_end() {
			self.goal_column = None;
			self.reset_blink(cx);
			cx.emit(EditorEvent::Changed);
			cx.notify();
		}
	}
}
