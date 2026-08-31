//! Platform-aware titlebar and client frame chrome.
//!
//! Product content comes from `features::shell`; this module supplies only the
//! geometry and actions that require a real window.

mod resize;

use gpui::{
	App, Context, Decorations, Div, InteractiveElement, MouseButton, MouseDownEvent, ParentElement,
	Stateful, Styled, Window, div, px,
};
pub use resize::edges as resize_edges;
use veyyon_gui_core::Store;
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Theme, layout, space, titlebar_density},
	ui::{Button, Fill, Icon, Tone},
};

use crate::shell::Shell;

pub fn owns_frame(window: &Window) -> bool {
	matches!(window.window_decorations(), Decorations::Client { .. })
}

pub fn titlebar(store: &Store, window: &Window, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let left = if cfg!(target_os = "macos") {
		layout::MACOS_TRAFFIC_LIGHT_CLEARANCE
	} else {
		layout::TITLEBAR_INSET
	};
	let controls = (!cfg!(target_os = "macos") && owns_frame(window)).then(|| window_controls(cx));
	div()
		.id("platform-titlebar")
		.flex()
		.flex_none()
		.items_center()
		.w_full()
		.h(px(layout::titlebar()))
		.pl(px(left))
		.pr(px(if controls.is_some() {
			space::X4
		} else {
			layout::TITLEBAR_INSET
		}))
		.gap(px(space::X8))
		.bg(theme.ground)
		.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
			if event.click_count > 1 {
				window.zoom_window();
			} else {
				window.start_window_move();
			}
		})
		.child(veyyon_gui_features::shell::titlebar(
			store,
			titlebar_density(f32::from(window.viewport_size().width)),
			cx,
		))
		.children(controls)
}

fn window_controls(_cx: &mut App) -> Stateful<Div> {
	div()
		.id("window-controls")
		.flex()
		.flex_none()
		.items_center()
		.gap(px(space::X4))
		.child(
			Button::new(
				"window-minimize",
				owner(OwnerNamespace::Shell, "window", "window-minimize"),
				Icon::Less,
			)
			.tip("Minimize window")
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(|_, window, _| window.minimize_window()),
		)
		.child(
			Button::new(
				"window-maximize",
				owner(OwnerNamespace::Shell, "window", "window-maximize"),
				Icon::More,
			)
			.tip("Maximize or restore window")
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(|_, window, _| window.zoom_window()),
		)
		.child(
			Button::new(
				"window-close",
				owner(OwnerNamespace::Shell, "window", "window-close"),
				Icon::Close,
			)
			.tip("Close window")
			.fill(Fill::Ghost)
			.tone(Tone::Danger)
			.on_click(|_, window, _| window.remove_window()),
		)
}
