//! Mouse event handlers for Editor view (§8.25).

use veyyon_gpui::{Context, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Window};

use super::Editor;

impl Editor {
	pub(crate) fn on_mouse_down(
		&mut self,
		event: &MouseDownEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if !self.focus_handle.is_focused(window) {
			self.focus_handle.focus(window, cx);
		}

		self.is_selecting = true;
		if let Some(layout) = &self.last_layout
			&& let Some(offset) = layout.character_index_for_point(event.position)
		{
			if event.click_count == 2 {
				self.buffer.select_word_at(offset);
			} else if event.click_count >= 3 {
				self.buffer.select_all();
			} else if event.modifiers.shift {
				self.buffer.move_to(offset, true);
			} else {
				self.buffer.move_to(offset, false);
			}
			self.goal_column = None;
			self.reset_blink(cx);
			cx.notify();
		}
	}

	pub(crate) fn on_mouse_up(
		&mut self,
		_: &MouseUpEvent,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.is_selecting = false;
		cx.notify();
	}

	pub(crate) fn on_mouse_move(
		&mut self,
		event: &MouseMoveEvent,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.is_selecting
			&& let Some(layout) = &self.last_layout
			&& let Some(offset) = layout.character_index_for_point(event.position)
		{
			self.buffer.move_to(offset, true);
			self.goal_column = None;
			cx.notify();
		}
	}
}
