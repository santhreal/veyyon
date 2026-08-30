//! The mouse: where a click lands, what a drag selects, and how a wheel
//! scrolls a field that has grown taller than it is allowed to draw.

use super::*;

impl Editor {
	pub(super) fn on_mouse_down(
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

	pub(super) fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
		self.dragging = false;
	}

	pub(super) fn on_mouse_move(
		&mut self,
		event: &MouseMoveEvent,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.dragging {
			let offset = self.offset_at(event.position);
			self.select_to(offset, cx);
		}
	}

	pub(super) fn on_scroll(
		&mut self,
		event: &ScrollWheelEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
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
}
