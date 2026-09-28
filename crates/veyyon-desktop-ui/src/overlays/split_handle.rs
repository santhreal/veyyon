//! The strip between two resizable regions.

use std::{cell::Cell, rc::Rc};

use veyyon_gpui::{
	App, Axis, ClickEvent, DragMoveEvent, ElementId, EmptyView, IntoElement, Pixels,
	Point, RenderOnce, Window, div, prelude::*,
};

use crate::theme::{ActiveTheme, size};

type DragHandler = Rc<dyn Fn(Pixels, &mut Window, &mut App)>;
type ResetHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A [`size::RESIZE_HANDLE`] wide strip that resizes the regions beside it.
///
/// `axis` is the direction of the drag: a [`Axis::Horizontal`] handle stands
/// between side-by-side regions and shows the column-resize cursor, a
/// [`Axis::Vertical`] one lies between stacked regions and shows the
/// row-resize cursor. While dragged it reports each pointer movement along
/// `axis` to [`SplitHandle::on_drag`]; a double click calls
/// [`SplitHandle::on_reset`]. Hovering draws a one-pixel `border.strong` rule
/// down its middle.
#[derive(IntoElement)]
pub struct SplitHandle {
	id:       ElementId,
	axis:     Axis,
	on_drag:  Option<DragHandler>,
	on_reset: Option<ResetHandler>,
}

/// The payload of an active split drag.
struct SplitDrag {
	id:   ElementId,
	/// Pointer offset from the handle's origin when the button went down.
	grab: Cell<Point<Pixels>>,
	/// Pointer position at the last reported movement.
	last: Cell<Option<Point<Pixels>>>,
}

impl SplitHandle {
	/// A handle dragged along `axis`. `id` must be unique in the window.
	pub fn new(id: impl Into<ElementId>, axis: Axis) -> Self {
		Self { id: id.into(), axis, on_drag: None, on_reset: None }
	}

	/// Calls `handler` with the distance the pointer moved along the axis
	/// since the previous call of the same drag.
	pub fn on_drag(mut self, handler: impl Fn(Pixels, &mut Window, &mut App) + 'static) -> Self {
		self.on_drag = Some(Rc::new(handler));
		self
	}

	/// Calls `handler` on a double click, to restore the default size.
	pub fn on_reset(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
		self.on_reset = Some(Rc::new(handler));
		self
	}
}

impl RenderOnce for SplitHandle {
	fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
		let line = cx.theme().palette.border.strong;
		let axis = self.axis;
		let id = self.id.clone();
		let on_drag = self.on_drag;
		let on_reset = self.on_reset;
		let payload = SplitDrag { id: self.id.clone(), grab: Cell::default(), last: Cell::new(None) };
		div()
			.id(self.id)
			.group("split-handle")
			.flex()
			.flex_none()
			.justify_center()
			.items_center()
			.map(|el| match axis {
				Axis::Horizontal => el.w(size::RESIZE_HANDLE).h_full().cursor_col_resize(),
				Axis::Vertical => el.h(size::RESIZE_HANDLE).w_full().cursor_row_resize(),
			})
			.on_drag(payload, |drag: &SplitDrag, offset, _, cx| {
				drag.grab.set(offset);
				drag.last.set(None);
				cx.new(|_| EmptyView)
			})
			.on_drag_move(move |event: &DragMoveEvent<SplitDrag>, window, cx| {
				let drag = event.drag(cx);
				if drag.id != id {
					return;
				}
				let pointer = event.event.position;
				let last = drag.last.get().unwrap_or_else(|| event.bounds.origin + drag.grab.get());
				drag.last.set(Some(pointer));
				let delta = match axis {
					Axis::Horizontal => pointer.x - last.x,
					Axis::Vertical => pointer.y - last.y,
				};
				if let Some(on_drag) = on_drag.as_ref().filter(|_| delta != Pixels::ZERO) {
					on_drag(delta, window, cx);
				}
			})
			.on_click(move |event: &ClickEvent, window, cx| {
				if event.click_count() >= 2
					&& let Some(on_reset) = on_reset.as_ref()
				{
					on_reset(window, cx);
				}
			})
			.child(
				div()
					.map(|el| match axis {
						Axis::Horizontal => el.w_px().h_full(),
						Axis::Vertical => el.h_px().w_full(),
					})
					.group_hover("split-handle", move |style| style.bg(line)),
			)
	}
}
