//! Dragging the sidebar's edge.
//!
//! The width follows the hand exactly: the press records where the pointer went
//! down and how wide the sidebar was then, so a grab anywhere on the handle
//! does not jump the edge to the pointer.

use super::*;

impl Shell {
	pub fn begin_drag(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
		if event.click_count > 1 {
			moves::reset_sidebar_width(&mut self.store);
			self.store.settings.sidebar_open = true;
			cx.notify();
			return;
		}
		self.drag = Some(Drag {
			from_x: f32::from(event.position.x),
			width:  self.store.settings.sidebar_width,
		});
	}

	pub fn drag_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
		let Some(Drag { from_x, width }) = self.drag else {
			return;
		};
		let target = width + (f32::from(event.position.x) - from_x);
		// A drag past the minimum closes the sidebar rather than sticking at the
		// minimum, and dragging back out reopens it.
		if target < SIDEBAR_MIN - 40.0 {
			self.store.settings.sidebar_open = false;
		} else {
			self.store.settings.sidebar_open = true;
			moves::set_sidebar_width(&mut self.store, target);
		}
		// The width is snapped rather than driven: it is already following the
		// hand, and a tween on top of a drag lags behind the pointer.
		let width = self.sidebar_target();
		let now = self.now;
		paint::registry(cx).snap(Key::of(Channel::SidebarWidth), width, now);
		cx.notify();
	}

	pub fn end_drag(&mut self, cx: &mut Context<Self>) {
		if self.drag.take().is_some() {
			cx.notify();
		}
	}

	pub fn sidebar_target(&self) -> f32 {
		if self.store.settings.sidebar_open {
			self.store.settings.sidebar_width
		} else {
			0.0
		}
	}
}
