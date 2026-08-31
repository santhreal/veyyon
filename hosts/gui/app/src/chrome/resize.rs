//! Resize hit regions for client-decorated windows.

use gpui::{
	CursorStyle, InteractiveElement, MouseButton, ParentElement, ResizeEdge, Styled, Window, div, px,
};
use veyyon_gui_kit::theme::layout;

use super::owns_frame;

pub fn edges(window: &Window) -> Option<gpui::Div> {
	if !owns_frame(window) {
		return None;
	}
	let hit = px(layout::HANDLE_HIT);
	let edge = |id: &'static str, resize: ResizeEdge, cursor: CursorStyle| {
		div().id(id).absolute().cursor(cursor).on_mouse_down(
			MouseButton::Left,
			move |_, window, cx| {
				window.start_window_resize(resize);
				cx.stop_propagation();
			},
		)
	};
	Some(
		div()
			.absolute()
			.inset_0()
			.child(
				edge("resize-top", ResizeEdge::Top, CursorStyle::ResizeUp)
					.top_0()
					.left_0()
					.right_0()
					.h(hit),
			)
			.child(
				edge("resize-bottom", ResizeEdge::Bottom, CursorStyle::ResizeDown)
					.bottom_0()
					.left_0()
					.right_0()
					.h(hit),
			)
			.child(
				edge("resize-left", ResizeEdge::Left, CursorStyle::ResizeLeft)
					.left_0()
					.top_0()
					.bottom_0()
					.w(hit),
			)
			.child(
				edge("resize-right", ResizeEdge::Right, CursorStyle::ResizeRight)
					.right_0()
					.top_0()
					.bottom_0()
					.w(hit),
			)
			.child(
				edge("resize-top-left", ResizeEdge::TopLeft, CursorStyle::ResizeUpRightDownLeft)
					.top_0()
					.left_0()
					.size(hit),
			)
			.child(
				edge("resize-top-right", ResizeEdge::TopRight, CursorStyle::ResizeUpLeftDownRight)
					.top_0()
					.right_0()
					.size(hit),
			)
			.child(
				edge("resize-bottom-left", ResizeEdge::BottomLeft, CursorStyle::ResizeUpLeftDownRight)
					.bottom_0()
					.left_0()
					.size(hit),
			)
			.child(
				edge(
					"resize-bottom-right",
					ResizeEdge::BottomRight,
					CursorStyle::ResizeUpRightDownLeft,
				)
				.bottom_0()
				.right_0()
				.size(hit),
			),
	)
}
