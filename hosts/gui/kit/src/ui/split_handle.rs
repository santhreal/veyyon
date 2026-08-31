//! Direct-manipulation split handle.
//!
//! The visible divider is four pixels while the pointer hit band is twelve.
//! Dragging remains direct; the parent coalesces pointer updates and may
//! retarget a layout spring only when release clamps or snaps the value.

use gpui::{
	App, ElementId, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement,
	RenderOnce, SharedString, Styled, Window, div, px,
};

use crate::theme::{Theme, layout};

type BeginDrag = Box<dyn Fn(&MouseDownEvent, &mut Window, &mut App) + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitAxis {
	Horizontal,
	Vertical,
}

#[derive(IntoElement)]
pub struct SplitHandle {
	id:       SharedString,
	axis:     SplitAxis,
	on_begin: Option<BeginDrag>,
}
impl SplitHandle {
	pub fn new(id: impl Into<SharedString>, axis: SplitAxis) -> Self {
		Self { id: id.into(), axis, on_begin: None }
	}

	pub fn on_begin(
		mut self,
		listener: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_begin = Some(Box::new(listener));
		self
	}
}
impl RenderOnce for SplitHandle {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let line = match self.axis {
			SplitAxis::Horizontal => div().w(px(layout::HANDLE)).h_full(),
			SplitAxis::Vertical => div().h(px(layout::HANDLE)).w_full(),
		}
		.bg(theme.stroke);
		let mut hit = div()
			.id(ElementId::from(self.id))
			.flex()
			.items_center()
			.justify_center();
		hit = match self.axis {
			SplitAxis::Horizontal => hit.w(px(layout::HANDLE_HIT)).h_full().cursor_col_resize(),
			SplitAxis::Vertical => hit.h(px(layout::HANDLE_HIT)).w_full().cursor_row_resize(),
		};
		hit = hit.child(line);
		match self.on_begin {
			Some(listener) => hit
				.on_mouse_down(MouseButton::Left, move |event, window, cx| listener(event, window, cx)),
			None => hit,
		}
	}
}
