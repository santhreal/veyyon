//! Cursor navigation and selection actions for Editor view (§8.25).

use veyyon_gpui::{Context, Window, point, px};

use super::{
	Editor,
	actions::{
		MoveDocEnd, MoveDocStart, MoveDown, MoveLeft, MoveLineEnd, MoveLineStart, MoveRight, MoveUp,
		MoveWordLeft, MoveWordRight, SelectDocEnd, SelectDocStart, SelectDown, SelectLeft,
		SelectLineEnd, SelectLineStart, SelectRight, SelectUp, SelectWordLeft, SelectWordRight,
	},
};

impl Editor {
	pub(crate) fn move_vertical(&mut self, direction: isize, select: bool, cx: &mut Context<Self>) {
		if let Some(layout) = &self.last_layout {
			let head = self.buffer.selection().head;
			let current_vl_idx = layout.visual_line_for_offset(head);

			let goal_x = if let Some(gx) = self.goal_column {
				gx
			} else {
				let current_pos = layout
					.position_for_offset(head)
					.unwrap_or(point(px(0.0), px(0.0)));
				self.goal_column = Some(current_pos.x);
				current_pos.x
			};

			let target_vl_idx = if direction < 0 {
				if current_vl_idx == 0 {
					if select {
						self.buffer.move_doc_start(true);
					} else {
						self.buffer.move_doc_start(false);
					}
					self.reset_blink(cx);
					cx.notify();
					return;
				}
				current_vl_idx.saturating_sub(1)
			} else {
				if current_vl_idx + 1 >= layout.visual_line_count() {
					if select {
						self.buffer.move_doc_end(true);
					} else {
						self.buffer.move_doc_end(false);
					}
					self.reset_blink(cx);
					cx.notify();
					return;
				}
				current_vl_idx + 1
			};

			let new_offset = layout.closest_offset_for_visual_line_and_x(target_vl_idx, goal_x);
			self.buffer.move_to(new_offset, select);
			self.reset_blink(cx);
			cx.notify();
		}
	}

	pub(crate) fn move_left_action(
		&mut self,
		_: &MoveLeft,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_left(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_right_action(
		&mut self,
		_: &MoveRight,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_right(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_up_action(
		&mut self,
		_: &MoveUp,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.move_vertical(-1, false, cx);
	}

	pub(crate) fn move_down_action(
		&mut self,
		_: &MoveDown,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.move_vertical(1, false, cx);
	}

	pub(crate) fn select_left_action(
		&mut self,
		_: &SelectLeft,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_left(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_right_action(
		&mut self,
		_: &SelectRight,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_right(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_up_action(
		&mut self,
		_: &SelectUp,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.move_vertical(-1, true, cx);
	}

	pub(crate) fn select_down_action(
		&mut self,
		_: &SelectDown,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.move_vertical(1, true, cx);
	}

	pub(crate) fn move_word_left_action(
		&mut self,
		_: &MoveWordLeft,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_word_left(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_word_right_action(
		&mut self,
		_: &MoveWordRight,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_word_right(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_word_left_action(
		&mut self,
		_: &SelectWordLeft,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_word_left(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_word_right_action(
		&mut self,
		_: &SelectWordRight,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_word_right(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_line_start_action(
		&mut self,
		_: &MoveLineStart,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_line_start(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_line_end_action(
		&mut self,
		_: &MoveLineEnd,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_line_end(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_line_start_action(
		&mut self,
		_: &SelectLineStart,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_line_start(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_line_end_action(
		&mut self,
		_: &SelectLineEnd,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_line_end(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_doc_start_action(
		&mut self,
		_: &MoveDocStart,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_doc_start(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn move_doc_end_action(
		&mut self,
		_: &MoveDocEnd,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_doc_end(false);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_doc_start_action(
		&mut self,
		_: &SelectDocStart,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_doc_start(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}

	pub(crate) fn select_doc_end_action(
		&mut self,
		_: &SelectDocEnd,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.buffer.move_doc_end(true);
		self.goal_column = None;
		self.reset_blink(cx);
		cx.notify();
	}
}
