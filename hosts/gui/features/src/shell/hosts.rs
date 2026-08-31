//! Containers for persistent route surfaces.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, MouseButton, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::{BottomTab, InspectorTab},
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Appearance, Theme, layout, opacity, space},
	ui::{Tab, Tabs},
};

use crate::act;

pub fn sidebar(header: AnyElement, body: AnyElement, width: f32, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	div()
		.id("contextual-sidebar")
		.flex()
		.flex_col()
		.flex_none()
		.w(px(width))
		.min_w(px(0.0))
		.h_full()
		.overflow_hidden()
		.bg(theme.chrome)
		.border_r_1()
		.border_color(theme.stroke)
		.child(header)
		.child(body)
		.into_any_element()
}

pub fn workspace(toolbar: AnyElement, body: AnyElement, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	div()
		.id("center-workspace")
		.flex()
		.flex_col()
		.flex_1()
		.min_w(px(0.0))
		.min_h(px(0.0))
		.overflow_hidden()
		.bg(theme.canvas)
		.child(toolbar)
		.child(body)
		.into_any_element()
}

pub fn inspector(store: &Store, body: AnyElement, width: f32, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let selected = store.frontend.inspector_tab;
	let tabs = InspectorTab::ALL
		.into_iter()
		.fold(Tabs::new("inspector-tabs"), |tabs, tab| {
			tabs.tab(
				Tab::new(
					owner(OwnerNamespace::Shell, "inspector-tab", tab.label()),
					tab.label(),
					selected == tab,
				)
				.on_click(act::click(UiCommand::SetInspectorTab(tab))),
			)
		})
		.stretch();
	div()
		.id("inspector-host")
		.flex()
		.flex_col()
		.flex_none()
		.w(px(width))
		.min_w(px(0.0))
		.h_full()
		.overflow_hidden()
		.bg(theme.chrome)
		.border_l_1()
		.border_color(theme.stroke)
		.child(div().flex_none().p(px(space::X6)).child(tabs))
		.child(body)
		.into_any_element()
}

pub fn bottom_dock(store: &Store, body: AnyElement, height: f32, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let selected = store.frontend.bottom_tab;
	let tabs = BottomTab::ALL
		.into_iter()
		.fold(Tabs::new("bottom-tabs"), |tabs, tab| {
			tabs.tab(
				Tab::new(
					owner(OwnerNamespace::Shell, "dock-tab", tab.label()),
					tab.label(),
					selected == tab,
				)
				.on_click(act::click(UiCommand::SetBottomTab(tab))),
			)
		});
	div()
		.id("bottom-dock-host")
		.flex()
		.flex_col()
		.flex_none()
		.w_full()
		.h(px(height))
		.min_h(px(0.0))
		.overflow_hidden()
		.bg(theme.chrome)
		.border_t_1()
		.border_color(theme.stroke)
		.child(
			div()
				.flex()
				.flex_none()
				.items_center()
				.h(px(layout::toolbar()))
				.px(px(space::X8))
				.child(tabs),
		)
		.child(body)
		.into_any_element()
}

pub fn sheet(
	id: &'static str,
	side: SheetSide,
	body: AnyElement,
	width: f32,
	dismiss: UiCommand,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let panel = div()
		.id(id)
		.absolute()
		.top(px(0.0))
		.bottom(px(0.0))
		.w(px(width))
		.overflow_hidden()
		.bg(theme.overlay)
		.shadow(theme.shadow_sheet())
		.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
		.child(body);
	let panel = match side {
		SheetSide::Left => panel.left(px(0.0)),
		SheetSide::Right => panel.right(px(0.0)),
	};
	div()
		.id(id)
		.absolute()
		.inset_0()
		.bg(theme.scrim().opacity(match theme.appearance {
			Appearance::Dark => opacity::SCRIM_DARK,
			Appearance::Light => opacity::SCRIM_LIGHT,
		}))
		.on_click(act::click(dismiss))
		.child(panel)
		.into_any_element()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetSide {
	Left,
	Right,
}
