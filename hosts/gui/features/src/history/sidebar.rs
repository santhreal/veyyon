//! History sidebar: session search, day/repo collapsible groups, and row
//! rendering.

use gpui::{
	App, Div, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle,
	StatefulInteractiveElement, Styled, Window, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{RemoteData, SessionStatus},
	navigation::HistoryGroupBy,
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey, owner},
	theme::{Elevation, Theme, space},
	ui::{
		Badge, Banner, Button, EdgeFade, Empty, Fill, Icon, Row, Scrolls, SearchField, Tone, text,
	},
};

use super::logic::{self, HistoryGroup, HistoryRowItem, SearchScope};
use crate::act;

fn history_owner(slot: &str) -> RetainedKey {
	owner(OwnerNamespace::Shell, "history-sidebar", slot)
}

fn row_owner(id: &str) -> RetainedKey {
	owner(OwnerNamespace::Shell, "history-row", id)
}

fn group_owner(key: &str) -> RetainedKey {
	owner(OwnerNamespace::Shell, "history-group", key)
}

/// The history session browser sidebar.
pub fn render_sidebar(
	store: &Store,
	search: &Entity<Editor>,
	scroll: &ScrollHandle,
	_window: &mut Window,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let mut shelf = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.chrome)
		.child(shelf_header(store, search, &theme));

	let sessions_data = match &store.replica.sessions.sessions {
		RemoteData::Ready(version) => Some(version.value.as_slice()),
		RemoteData::Stale { value, reason } => {
			shelf = shelf.child(
				Banner::notice("Conversation list is offline")
					.detail(format!("Showing cached index: {reason:?}")),
			);
			Some(value.value.as_slice())
		},
		RemoteData::Loading { .. } => {
			return shelf.child(
				Empty::new("Loading history...")
					.icon(Icon::Running)
					.note("Fetching session index from engine")
					.filling(),
			);
		},
		RemoteData::Unrequested | RemoteData::Empty => {
			return shelf.child(
				Empty::new("No session history")
					.icon(Icon::Conversation)
					.note("No past conversations were found")
					.filling(),
			);
		},
		RemoteData::Error { message, .. } => {
			return shelf.child(Banner::failure("Failed to load history").detail(message.clone()));
		},
	};

	let Some(sessions) = sessions_data else {
		return shelf;
	};

	let query = store.frontend.history.filter.as_str();
	let group_by = store.frontend.history.group_by;
	let now_ms = store
		.replica
		.sessions
		.sessions
		.readable()
		.and_then(|v| v.value.iter().map(|s| s.modified_at_ms).max())
		.unwrap_or(0);

	let groups = logic::filter_and_group(sessions, query, group_by, now_ms);
	shelf.child(groups_list(store, &groups, scroll, &theme))
}

fn shelf_header(store: &Store, search: &Entity<Editor>, theme: &Theme) -> Div {
	let current_group_by = store.frontend.history.group_by;
	let toggle_group_by = match current_group_by {
		HistoryGroupBy::Date => HistoryGroupBy::Repository,
		HistoryGroupBy::Repository => HistoryGroupBy::Date,
	};
	let group_btn_label = match current_group_by {
		HistoryGroupBy::Date => "By Date",
		HistoryGroupBy::Repository => "By Repository",
	};

	div()
		.flex()
		.flex_col()
		.gap(px(space::X8))
		.p(px(space::X12))
		.child(
			div()
				.flex()
				.items_center()
				.child(text::heading("Session history", theme))
				.child(text::spacer())
				.child(
					Button::labelled("history-group-mode", history_owner("group-mode"), group_btn_label)
						.fill(Fill::Ghost)
						.tone(Tone::Muted)
						.tip("Toggle date / repository grouping")
						.on_click(act::click(UiCommand::SetHistoryGroupBy(toggle_group_by))),
				),
		)
		.child(SearchField::new("history-search", history_owner("search-field"), search.clone()))
}

fn groups_list(
	store: &Store,
	groups: &[HistoryGroup],
	scroll: &ScrollHandle,
	theme: &Theme,
) -> EdgeFade {
	if groups.is_empty() {
		return div()
			.id("empty-history-sessions")
			.flex()
			.flex_1()
			.min_h(px(0.0))
			.child(
				Empty::new("No matching sessions")
					.icon(Icon::Search)
					.note("Try refining your search query")
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Chrome);
	}

	let mut list = div()
		.id("history-sessions-list")
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.gap(px(space::ROWS))
		.px(px(space::X8))
		.pb(px(space::X12));

	for group in groups {
		let is_collapsed = store.frontend.history.is_collapsed(&group.key);
		list = list.child(group_header(group, is_collapsed, theme));
		if !is_collapsed {
			for item in &group.rows {
				list = list.child(session_item_row(store, item));
			}
		}
	}

	list.scrolls_y(scroll, Elevation::Chrome)
}

fn group_header(group: &HistoryGroup, collapsed: bool, theme: &Theme) -> impl IntoElement {
	let icon = if collapsed { Icon::Folded } else { Icon::Open };
	let count_label =
		format!("{} session{}", group.rows.len(), if group.rows.len() == 1 { "" } else { "s" });

	div()
		.id(format!("group-header:{}", group.key))
		.flex()
		.items_center()
		.gap(px(space::X6))
		.pt(px(space::X8))
		.pb(px(space::X4))
		.px(px(space::X4))
		.cursor_pointer()
		.on_click(act::click(UiCommand::ToggleHistoryGroup(group.key.clone())))
		.child(
			Button::new(format!("caret:{}", group.key), group_owner(&group.key), icon)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.on_click(act::click(UiCommand::ToggleHistoryGroup(group.key.clone()))),
		)
		.child(text::overline(group.label.clone(), theme))
		.child(text::spacer())
		.child(Badge::new(count_label).tone(Tone::Muted).bare())
}

fn session_item_row(store: &Store, item: &HistoryRowItem) -> Row {
	let is_selected = store.frontend.selected_session.as_ref() == Some(&item.id);
	let subtitle =
		format!("{} • {} msgs • {}", item.repository, item.message_count, item.formatted_size);

	let scope_badge = match item.search_scope {
		SearchScope::FullMessages => Badge::new("Full index").tone(Tone::Muted).bare(),
		SearchScope::FirstMessageAndTitle => Badge::new("1st msg & title").tone(Tone::Warn).bare(),
		SearchScope::Unsearchable => Badge::new("Unsearchable").tone(Tone::Danger).bare(),
	};

	let status_badge = Badge::new(status_label(item.status))
		.tone(status_tone(item.status))
		.bare();

	Row::new(format!("history:{}", item.id), row_owner(item.id.as_str()), item.title.clone())
		.note(subtitle)
		.active(is_selected)
		.child(scope_badge)
		.child(status_badge)
		.on_click(act::click(UiCommand::OpenSession(item.id.clone())))
}

fn status_label(status: SessionStatus) -> &'static str {
	match status {
		SessionStatus::Complete => "Complete",
		SessionStatus::Interrupted => "Interrupted",
		SessionStatus::Aborted => "Aborted",
		SessionStatus::Error => "Error",
		SessionStatus::Pending => "Active",
		SessionStatus::Unknown => "Unknown",
	}
}

fn status_tone(status: SessionStatus) -> Tone {
	match status {
		SessionStatus::Complete | SessionStatus::Unknown => Tone::Muted,
		SessionStatus::Pending => Tone::Accent,
		SessionStatus::Interrupted | SessionStatus::Aborted => Tone::Warn,
		SessionStatus::Error => Tone::Danger,
	}
}
