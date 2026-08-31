//! Horizontal tab strip with reordering, active highlighting, and close
//! affordance.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};
use veyyon_gui_core::{Store, UiCommand, model::SessionId};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner, owner_at},
	theme::{Theme, layout, radius, space, weight},
	ui::{Button, Fill, Icon, Tone, text},
};

use crate::act;

/// Hit-testing for tab reordering by pointer coordinate against laid-out tab
/// boundaries.
pub fn tab_target_index(pointer_x: f32, tab_rects: &[(f32, f32)]) -> usize {
	if tab_rects.is_empty() {
		return 0;
	}
	for (idx, &(start_x, end_x)) in tab_rects.iter().enumerate() {
		let midpoint = (start_x + end_x) / 2.0;
		if pointer_x < midpoint {
			return idx;
		}
		if pointer_x <= end_x {
			return idx;
		}
	}
	tab_rects.len() - 1
}

pub fn tab_strip(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let Some(active_space) = store.frontend.spaces.active() else {
		return div().into_any_element();
	};

	let active_index = active_space.active_tab;
	let tabs = active_space.tabs.iter().enumerate().map(|(index, tab)| {
		let is_active = active_index == Some(index);
		let title = session_tab_title(store, &tab.session);
		let tab_owner =
			owner_at(OwnerNamespace::Shell, "tab-strip-tab", tab.session.as_str(), index as u64);

		let bg = if is_active {
			theme.raised
		} else {
			theme.canvas
		};

		let border_color = if is_active {
			theme.accent
		} else {
			theme.stroke
		};

		div()
			.id(format!("space-tab-{index}"))
			.flex()
			.items_center()
			.h(px(layout::toolbar() - space::X4))
			.px(px(space::X8))
			.gap(px(space::X4))
			.rounded(px(radius::CONTROL))
			.bg(bg)
			.border_b_1()
			.border_color(border_color)
			.cursor_pointer()
			.on_click(act::click(UiCommand::SelectTab(index)))
			.child(div().flex().items_center().min_w(px(0.0)).child(
				text::label(&title, &theme).font_weight(if is_active {
					weight::STRONG
				} else {
					weight::REGULAR
				}),
			))
			.child(
				Button::new(format!("close-tab-{index}"), tab_owner, Icon::Close)
					.tip("Close tab")
					.fill(Fill::Ghost)
					.tone(Tone::Muted)
					.on_click(act::click(UiCommand::CloseTab { index, force: false })),
			)
	});

	div()
		.id("tab-strip")
		.flex()
		.items_center()
		.gap(px(space::X4))
		.h(px(layout::toolbar()))
		.px(px(space::X4))
		.bg(theme.chrome)
		.border_b_1()
		.border_color(theme.stroke)
		.children(tabs)
		.child(
			Button::new(
				"new-tab-button",
				owner(OwnerNamespace::Shell, "tab-strip", "new-tab"),
				Icon::New,
			)
			.tip("New conversation tab")
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(act::click(UiCommand::CreateSession { workspace: None, parent: None })),
		)
		.into_any_element()
}

fn session_tab_title(store: &Store, session: &SessionId) -> String {
	if let Some(header) = store.replica.active_session.readable()
		&& &header.value.id == session
		&& let Some(title) = &header.value.title
		&& !title.trim().is_empty()
	{
		return title.clone();
	}
	if let Some(sessions) = store.replica.sessions.sessions.readable()
		&& let Some(item) = sessions.value.iter().find(|s| &s.id == session)
		&& let Some(title) = &item.title
		&& !title.trim().is_empty()
	{
		return title.clone();
	}
	session.as_str().to_owned()
}
