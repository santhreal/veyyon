//! Route-local toolbar for the History surface.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand, navigation::HistoryGroupBy};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Theme, layout, space},
	ui::{Button, Fill, Icon, Tone, text},
};

use crate::act;

pub fn render_toolbar(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let current_group_by = store.frontend.history.group_by;
	let next_group_by = match current_group_by {
		HistoryGroupBy::Date => HistoryGroupBy::Repository,
		HistoryGroupBy::Repository => HistoryGroupBy::Date,
	};
	let group_toggle_label = match current_group_by {
		HistoryGroupBy::Date => "Group: Date",
		HistoryGroupBy::Repository => "Group: Repository",
	};

	div()
		.id("history-toolbar")
		.flex()
		.flex_none()
		.items_center()
		.h(px(layout::toolbar()))
		.px(px(space::X12))
		.gap(px(space::X8))
		.bg(theme.canvas)
		.child(text::label("History", &theme))
		.child(text::spacer())
		.child(
			Button::labelled(
				"history-toggle-group-by",
				owner(OwnerNamespace::Shell, "history-toolbar", "group-by"),
				group_toggle_label,
			)
			.icon(Icon::Filter)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(act::click(UiCommand::SetHistoryGroupBy(next_group_by))),
		)
		.child(
			Button::labelled(
				"history-expand-all",
				owner(OwnerNamespace::Shell, "history-toolbar", "expand-all"),
				"Expand all",
			)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(act::click(UiCommand::ExpandAllHistoryGroups)),
		)
		.into_any_element()
}
