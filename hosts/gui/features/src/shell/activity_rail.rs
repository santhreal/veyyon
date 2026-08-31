//! The persistent route rail.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::{Route, SettingsPage},
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Theme, layout, space},
	ui::{Button, Fill, Icon, Tone, text},
};

use crate::act;

struct Destination {
	id:    &'static str,
	label: &'static str,
	icon:  Icon,
	route: Route,
}

const DESTINATIONS: [Destination; 4] = [
	Destination {
		id:    "route-conversation",
		label: "Conversation",
		icon:  Icon::Conversation,
		route: Route::Conversation,
	},
	Destination {
		id:    "route-changes",
		label: "Changes",
		icon:  Icon::Changes,
		route: Route::Changes,
	},
	Destination { id: "route-files", label: "Files", icon: Icon::Files, route: Route::Files },
	Destination {
		id:    "route-agents",
		label: "Agents",
		icon:  Icon::Agents,
		route: Route::Agents,
	},
];

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let active = store.frontend.route;
	div()
		.id("activity-rail")
		.flex()
		.flex_col()
		.items_center()
		.flex_none()
		.w(px(layout::activity_rail()))
		.h_full()
		.bg(theme.ground)
		.gap(px(space::X4))
		.py(px(space::X6))
		.children(DESTINATIONS.map(|destination| {
			Button::new(
				destination.id,
				owner(OwnerNamespace::Shell, "activity", destination.id),
				destination.icon,
			)
			.tip(destination.label)
			.fill(if active == destination.route {
				Fill::Tinted
			} else {
				Fill::Ghost
			})
			.tone(if active == destination.route {
				Tone::Accent
			} else {
				Tone::Muted
			})
			.on(active == destination.route)
			.on_click(act::click(UiCommand::Navigate(destination.route)))
		}))
		.child(text::spacer())
		.child(
			Button::new(
				"toggle-terminal-dock",
				owner(OwnerNamespace::Shell, "activity", "toggle-terminal-dock"),
				Icon::Terminal,
			)
			.tip(if store.frontend.panels.bottom_open {
				"Hide terminal dock"
			} else {
				"Show terminal dock"
			})
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on(store.frontend.panels.bottom_open)
			.on_click(act::click(UiCommand::ToggleBottomDock)),
		)
		.child(
			Button::new(
				"route-settings",
				owner(OwnerNamespace::Shell, "activity", "route-settings"),
				Icon::Settings,
			)
			.tip("Settings")
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on(matches!(active, Route::Settings(_)))
			.on_click(act::click(UiCommand::Navigate(Route::Settings(SettingsPage::Appearance)))),
		)
		.into_any_element()
}
