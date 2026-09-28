//! The client-side titlebar: the window has no system title strip, so the
//! sidebar's top row and the thread header move the window, and the thread
//! header draws the window controls at its right end. With no session open
//! the empty state's top row does both in the thread header's place.

use gpui::{
	AnyElement, App, ClickEvent, CursorStyle, InteractiveElement, IntoElement, MouseButton,
	MouseDownEvent, ParentElement, Stateful, StatefulInteractiveElement, Styled, Window, div,
	prelude::FluentBuilder,
};
use veyyon_desktop_ui::{
	controls::hover_transition,
	icons::{Icon, IconName},
	theme::{ActiveTheme, radius, size},
};

use crate::driver;

/// Makes `element` move the window when pressed and toggle maximize when
/// double-clicked. The sidebar's top row, the thread header and the empty
/// state's top row use it.
pub fn drag_region<E: InteractiveElement>(element: E) -> E {
	element.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
		if event.click_count >= 2 {
			window.zoom_window();
		} else {
			window.start_window_move();
		}
	})
}

/// The minimize, maximize and close buttons the platform draws no frame
/// for. macOS draws its own, so this is empty there.
pub fn window_controls(window: &Window, cx: &App) -> AnyElement {
	if cfg!(target_os = "macos") {
		return div().into_any_element();
	}
	let controls = window.window_controls();
	let muted = cx.theme().palette.text.muted;
	let minimize = div()
		.w(size::ICON_SM)
		.h(size::HAIRLINE)
		.bg(muted)
		.into_any_element();
	let maximize = Icon::new(IconName::Square)
		.size(size::ICON_SM)
		.color(muted)
		.into_any_element();
	let close = Icon::new(IconName::X)
		.size(size::ICON)
		.color(muted)
		.into_any_element();
	driver::target(
		"window.controls",
		div()
			.flex()
			.flex_none()
			.items_center()
			.gap(veyyon_desktop_ui::theme::space::S1)
			.when(controls.minimize, |row| {
				row.child(
					control("window.minimize", minimize, cx)
						.on_click(|_: &ClickEvent, window, _| window.minimize_window()),
				)
			})
			.when(controls.maximize, |row| {
				row.child(
					control("window.maximize", maximize, cx)
						.on_click(|_: &ClickEvent, window, _| window.zoom_window()),
				)
			})
			.child(
				control("window.close", close, cx)
					.on_click(|_: &ClickEvent, window, _| window.remove_window()),
			),
	)
}

/// One control button: a [`size::CONTROL`] square that stops the press from
/// reaching the drag region around it.
fn control(id: &'static str, glyph: AnyElement, cx: &App) -> Stateful<gpui::Div> {
	let palette = cx.theme().palette;
	div()
		.debug_selector(|| id.to_owned())
		.id(id)
		.flex()
		.flex_none()
		.items_center()
		.justify_center()
		.size(size::CONTROL)
		.rounded(radius::MD)
		.cursor(CursorStyle::PointingHand)
		.transition(hover_transition())
		.hover(move |style| style.bg(palette.bg.hover))
		.active(move |style| style.bg(palette.bg.selected))
		.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
		.child(glyph)
}
