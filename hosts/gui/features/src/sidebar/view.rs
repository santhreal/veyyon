//! Drawing the column.

use gpui::{
	AnyElement, App, Div, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::{
	command::Command,
	store::model::{Route, SettingsPage, Store},
};
use veyyon_gui_kit::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, space},
	ui::{Button, Disclosure, Fill, Icon, Row, Size, Tone, text},
};

use super::logic::{self, Column};
use crate::act;

/// The whole column: the list, and the way into settings under it.
pub fn render(store: &Store, cx: &mut App) -> Div {
	let mut list = div()
		.id("conversations")
		.flex()
		.flex_col()
		.gap(px(space::WIDE))
		.flex_1()
		.min_h(px(0.0))
		.overflow_y_scroll()
		.px(px(space::SNUG))
		.pb(px(space::BASE));

	let deletable = logic::deletable(store);
	for column in logic::columns(store) {
		list = list.child(checkout(&column, deletable, cx));
	}

	text::stack(0.0)
		.size_full()
		.min_w(px(0.0))
		.child(list)
		.child(settings(store, cx))
}

/// One checkout, with its conversations under it.
fn checkout(column: &Column, deletable: bool, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let rows: Vec<AnyElement> = column
		.rows
		.iter()
		.map(|entry| conversation(entry, deletable, cx).into_any_element())
		.collect();

	if !column.foldable {
		// One checkout: its name is the heading of the whole column, said once
		// and quietly. A fold with nothing to fold to is a control that costs a
		// press to learn it does nothing.
		return text::stack(space::TIGHT)
			.child(
				div()
					.px(px(space::BASE))
					.pt(px(space::TIGHT))
					.child(text::overline(column.name.clone(), &theme)),
			)
			.child(text::stack(2.0).children(rows))
			.into_any_element();
	}

	let project = column.project.clone();
	let count = column.rows.len();
	Disclosure::new(format!("checkout-{}", column.project.as_str()), column.name.clone())
		.open(!column.collapsed)
		.quiet()
		.icon(Icon::Checkout)
		.count(if count == 1 {
			"1".to_owned()
		} else {
			count.to_string()
		})
		.on_toggle(move |_, window, cx| act::run(Command::ToggleProject(project.clone()), window, cx))
		.children(rows)
		.into_any_element()
}

/// One conversation. Its delete appears only once the pointer is on the row, so
/// the column at rest is a column of names.
fn conversation(entry: &logic::Entry, deletable: bool, cx: &mut App) -> Row {
	let hovered = paint::at(cx, Key::named(Channel::Row, entry.id.as_str()));
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
	if deletable && hovered > 0.02 {
		let id = entry.id.clone();
		row = row.child(
			div().opacity(hovered).child(
				Button::new(format!("delete-{}", entry.id.as_str()), Icon::Delete)
					.tone(Tone::Danger)
					.fill(Fill::Ghost)
					.size(Size::Small)
					.tip("Delete this conversation")
					.on_click(move |_, window, cx| {
						act::run(Command::DeleteSession(id.clone()), window, cx)
					}),
			),
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
