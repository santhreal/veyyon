//! General local preferences plus the host-published General schema.

use gpui::{AnyElement, App, IntoElement, ParentElement};
use veyyon_gui_core::{Store, UiCommand, navigation::SettingsPage};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Field, Group, text},
};

use super::schema;
use crate::act;

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let mut grouped = crate::settings::controls::switch(
		"group-sessions-by-workspace",
		store.frontend.preferences.group_sessions_by_workspace,
	);
	grouped = grouped.on_click(act::click(UiCommand::SetGroupSessionsByWorkspace(
		!store.frontend.preferences.group_sessions_by_workspace,
	)));
	text::stack(space::LOOSE)
		.child(text::title("General", &theme))
		.child(
			Group::new("Session list").child(
				Field::new("Group sessions by workspace")
					.stacked()
					.note("Keeps related sessions together without changing engine state.")
					.child(grouped),
			),
		)
		.child(super::notifications::render(store, cx))
		.child(schema::render_embedded(store, SettingsPage::General, cx))
		.into_any_element()
}
