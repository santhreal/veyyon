//! Route-local title strip shared by routes without specialized controls.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand, navigation::Route};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Theme, layout, space},
	ui::{Button, Fill, Icon, Tone, text},
};

use crate::act;

pub fn route(store: &Store, route: Route, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let label = match route {
		Route::Conversation => "Conversation",
		Route::Changes => "Changes",
		Route::Files => "Files",
		Route::Agents => "Agents",
		Route::Settings(_) => "Settings",
		Route::History => "History",
	};
	let action = match route {
		Route::Changes => store.replica.changes.readable().map(|snapshot| {
			("Refresh changes", UiCommand::RefreshChanges(snapshot.value.scope.clone()))
		}),
		Route::Agents => Some(("Refresh agents", UiCommand::RefreshAgents)),
		Route::Conversation | Route::Files | Route::Settings(_) | Route::History => None,
	};
	div()
		.id("route-toolbar")
		.flex()
		.flex_none()
		.items_center()
		.h(px(layout::toolbar()))
		.px(px(space::X12))
		.gap(px(space::X8))
		.bg(theme.canvas)
		.child(text::label(label, &theme))
		.child(text::spacer())
		.children(action.map(|(tip, command)| {
			Button::new(
				"route-refresh",
				owner(OwnerNamespace::Shell, "toolbar", "route-refresh"),
				Icon::Retry,
			)
			.tip(tip)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(act::click(command))
		}))
		.into_any_element()
}
