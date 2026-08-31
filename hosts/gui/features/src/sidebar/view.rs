//! Drawing the column.

use gpui::{
	AnyElement, App, Div, InteractiveElement, IntoElement, ParentElement, ScrollHandle,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::{
	command::Command,
	store::model::{Route, SettingsPage, Store},
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Button, Disclosure, Fill, Icon, Row, Size, Tone, scrollbar::Scrollbar, text},
};

use super::logic::{self, Column};
use crate::act;

/// Where the conversation on screen sits among the list's own children, for the
/// window to put it back in view after a cycle.
///
/// A checkout with no fold contributes its heading and then each of its rows,
/// so the row itself is addressable. A folded checkout is one child holding its
/// rows, so what comes back is the group: gpui counts the children of the box
/// that scrolls, and a row inside a fold is not one of them.
pub fn selected_child(store: &Store) -> usize {
	let mut children = 0usize;
	for column in logic::columns(store) {
		if column.foldable {
			if column.rows.iter().any(|entry| entry.active) {
				return children;
			}
			children += 1;
			continue;
		}
		children += 1;
		for entry in &column.rows {
			if entry.active {
				return children;
			}
			children += 1;
		}
	}
	0
}

/// The whole column: the list, and the way into settings under it.
pub fn render(store: &Store, scroll: &ScrollHandle, cx: &mut App) -> Div {
	// Row spacing, not group spacing: a checkout's first element carries the
	// step between groups, because the rows are children of this box rather
	// than of a block per checkout. That is what makes a row addressable when
	// the keyboard cycles past the bottom of the list.
	let mut list = div()
		.id("conversations")
		.flex()
		.flex_col()
		.gap(px(space::ROWS))
		.flex_1()
		.min_h(px(0.0))
		.overflow_y_scroll()
		.track_scroll(scroll)
		.px(px(space::SNUG))
		.pb(px(space::BASE));

	let deletable = logic::deletable(store);
	for (index, column) in logic::columns(store).into_iter().enumerate() {
		for child in checkout(&column, deletable, index == 0, cx) {
			list = list.child(child);
		}
	}

	text::stack(0.0)
		.size_full()
		.min_w(px(0.0))
		.child(
			// The bar measures itself against the box it is in, so it is a
			// sibling of the list and not of the settings row under it.
			div()
				.relative()
				.flex()
				.flex_col()
				.flex_1()
				.min_h(px(0.0))
				.child(list)
				.child(Scrollbar::new("conversations-bar", scroll.clone())),
		)
		.child(settings(store, cx))
}

/// One checkout: its heading and its conversations, or one fold holding both.
///
/// `first` says whether the step above the heading is wanted, which every
/// checkout but the first one takes.
fn checkout(column: &Column, deletable: bool, first: bool, cx: &mut App) -> Vec<AnyElement> {
	let theme = Theme::get(cx);
	let step = if first {
		0.0
	} else {
		space::WIDE - space::ROWS
	};
	let rows = column
		.rows
		.iter()
		.map(|entry| conversation(entry, deletable).into_any_element());

	if !column.foldable {
		// One checkout: its name is the heading of the whole column, said once
		// and quietly. A fold with nothing to fold to is a control that costs a
		// press to learn it does nothing.
		let mut children = vec![
			div()
				.mt(px(step))
				.px(px(space::BASE))
				.pt(px(space::TIGHT))
				// The list's gap is a row's, and a heading stands further off
				// its rows than they do off each other.
				.pb(px(space::TIGHT - space::ROWS))
				.child(text::overline(column.name.clone(), &theme))
				.into_any_element(),
		];
		children.extend(rows);
		return children;
	}

	let project = column.project.clone();
	let count = column.rows.len();
	vec![
		div()
			.mt(px(step))
			.child(
				Disclosure::new(format!("checkout-{}", column.project.as_str()), column.name.clone())
					.open(!column.collapsed)
					.quiet()
					.icon(Icon::Checkout)
					.count(if count == 1 {
						"1".to_owned()
					} else {
						count.to_string()
					})
					.on_toggle(move |_, window, cx| {
						act::run(Command::ToggleProject(project.clone()), window, cx)
					})
					.children(rows),
			)
			.into_any_element(),
	]
}

/// One conversation. Its delete appears only once the pointer is on the row, so
/// the column at rest is a column of names.
fn conversation(entry: &logic::Entry, deletable: bool) -> Row {
	let id = entry.id.clone();
	let mut row = Row::new(format!("row-{}", entry.id.as_str()), entry.title.clone())
		.active(entry.active)
		.arriving()
		.tone(if entry.active {
			Tone::Plain
		} else {
			Tone::Muted
		})
		.on_click(move |_, window, cx| act::run(Command::SelectSession(id.clone()), window, cx));
	if let Some(preview) = entry.preview.clone() {
		row = row.note(preview);
	}
	if deletable {
		let id = entry.id.clone();
		row = row.hovered_child(
			Button::new(format!("delete-{}", entry.id.as_str()), Icon::Delete)
				.tone(Tone::Danger)
				.fill(Fill::Ghost)
				.size(Size::Small)
				.tip("Delete this conversation")
				.on_click(move |_, window, cx| {
					act::run(Command::DeleteSession(id.clone()), window, cx)
				}),
		);
	}
	row
}

/// The bottom of the column: settings, where a preferences entry sits in every
/// application with a sidebar.
fn settings(store: &Store, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let open = matches!(store.route, Route::Settings(_));
	// One line, above the last row of the column: the list scrolls under it, and
	// without it a long list runs into the settings row and reads as another
	// conversation.
	text::stack(space::SNUG)
		.flex_none()
		.pb(px(space::SNUG))
		.child(text::hairline(&theme))
		.child(
			div().px(px(space::SNUG)).child(
				Row::new("open-settings", "Settings")
					.icon(Icon::Settings)
					.tone(if open { Tone::Plain } else { Tone::Muted })
					.active(open)
					.on_click(act::click(Command::OpenSettings(SettingsPage::Appearance))),
			),
		)
}
