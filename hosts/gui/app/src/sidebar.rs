//! The conversation list, which is also the navigation.
//!
//! There is no tab strip. A conversation is reached from this list and the
//! content header names the one that is open, because a tab strip and a list
//! are two controls for one choice.
//!
//! HOW A ROW READS. A title, and under it the last thing said in that
//! conversation. No glyph column, no counter, no badge: the list is a column of
//! names, and a name is what the reader is looking for. A row recedes by
//! default and lifts under the pointer, where it also offers the one
//! destructive thing it can do, so nothing is offered until it is asked for.
//!
//! The order is `Store::rows`: most recently touched first.
//!
//! WHERE SETTINGS IS. The last row of this column, where a preferences entry
//! sits in every application with a sidebar. It is also `secondary-,` and a
//! palette command; three ways in, one of which is visible without knowing
//! anything.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, MouseButton, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::{
		model::{ProjectId, Route, SessionId, SettingsPage},
		moves,
	},
	theme::{Theme, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let projects: Vec<(ProjectId, String, bool)> = shell
		.store
		.projects
		.iter()
		.map(|project| (project.id.clone(), project.name.clone(), project.collapsed))
		.collect();
	// One checkout needs no fold and no header: a group of one is a heading
	// over the whole list, which the column already is.
	let grouped = shell.store.settings.group_by_folder && projects.len() > 1;

	let mut list = div()
		.id("conversations")
		.flex()
		.flex_col()
		.gap(px(space::WIDE))
		.flex_1()
		.min_h(px(0.0))
		.overflow_y_scroll()
		.px(px(space::BASE))
		.pb(px(space::BASE));

	for (id, name, collapsed) in projects {
		list = list.child(group(shell, &id, &name, collapsed, grouped, cx));
	}

	div()
		.flex()
		.flex_col()
		.size_full()
		.min_w(px(0.0))
		.child(list)
		.child(footer(shell, cx))
}

/// The bottom of the column: the way into settings.
fn footer(shell: &mut Shell, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let open = matches!(shell.store.route, Route::Settings(_));
	let key = Key::named(Channel::Control, "sidebar-settings");
	let hover = shell.motion.value(key, now);
	let ground = motion::mix(
		if open {
			theme.selected()
		} else {
			gpui::transparent_black()
		},
		if open {
			theme.selected()
		} else {
			theme.hover()
		},
		hover,
	);

	div()
		.id("open-settings")
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.h(px(38.0))
		.flex_none()
		.mx(px(space::BASE))
		.mb(px(space::BASE))
		.px(px(space::BASE))
		.rounded(px(radius::ROW))
		.bg(ground)
		.cursor_pointer()
		.text_size(px(size::SMALL))
		.text_color(if open { theme.text } else { theme.text_muted })
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.on_click(cx.listener(|shell, _, _, cx| {
			moves::open_settings(&mut shell.store, SettingsPage::Appearance);
			cx.notify();
		}))
		.child(div().flex_none().child(ui::glyph::SETTINGS))
		.child("Settings")
}

/// One checkout's conversations, with a foldable name above them when there is
/// more than one checkout to tell apart.
fn group(
	shell: &mut Shell,
	project: &ProjectId,
	name: &str,
	collapsed: bool,
	grouped: bool,
	cx: &mut Context<Shell>,
) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let rows: Vec<SessionId> = shell
		.store
		.rows(project)
		.into_iter()
		.map(|session| session.id.clone())
		.collect();
	let open = shell.motion.drive(
		Key::named(Channel::Group, project.as_str()),
		motion::COLLAPSE,
		if collapsed && grouped { 0.0 } else { 1.0 },
		now,
	);

	let mut column = div().flex().flex_col().gap(px(space::TIGHT));
	if grouped {
		let for_click = project.clone();
		column = column.child(
			div()
				.id(gpui::ElementId::Name(format!("group-{}", project.as_str()).into()))
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.h(px(26.0))
				.px(px(space::BASE))
				.cursor_pointer()
				.text_size(px(size::META))
				.text_color(theme.text_faint)
				.on_click(cx.listener(move |shell, _, _, cx| {
					moves::toggle_project(&mut shell.store, &for_click);
					cx.notify();
				}))
				.child(div().flex_none().child(if collapsed {
					ui::glyph::FOLDED
				} else {
					ui::glyph::OPEN
				}))
				.child(ui::line(name.to_owned())),
		);
	} else {
		// The checkout named once, quietly, as the heading of the whole column.
		column = column.child(
			div()
				.h(px(26.0))
				.px(px(space::BASE))
				.text_size(px(size::META))
				.text_color(theme.text_faint)
				.child(ui::line(name.to_owned())),
		);
	}

	if open > 0.01 {
		let mut body = div()
			.flex()
			.flex_col()
			.gap(px(2.0))
			.opacity(open)
			.overflow_hidden();
		for id in rows {
			body = body.child(row(shell, &id, cx));
		}
		column = column.child(body);
	}
	column
}

/// One conversation.
fn row(shell: &mut Shell, id: &SessionId, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	let now = shell.now;
	let Some(session) = shell.store.session(id) else {
		return div().into_any_element();
	};

	let selected = shell.store.selected.as_ref() == Some(id);
	let title = session.title.clone();
	let preview = session.preview();
	let deletable = shell.store.sessions.len() > 1;

	let hover_key = Key::named(Channel::Row, id.as_str());
	let enter_key = Key::named(Channel::RowEnter, id.as_str());
	let hover = shell.motion.value(hover_key, now);
	let appearing = shell.motion.enter(enter_key, motion::ENTER, now);

	// A selected row is a fill; an unselected one is the ground until the
	// pointer arrives. Both are the same channel, so a row selected while
	// hovered does not jump.
	let ground = motion::mix(
		if selected {
			theme.selected()
		} else {
			gpui::transparent_black()
		},
		if selected {
			theme.selected()
		} else {
			theme.hover()
		},
		hover,
	);

	let for_click = id.clone();
	let for_delete = id.clone();
	let delete = (deletable && hover > 0.02).then(|| {
		div()
			.id(gpui::ElementId::Name(format!("delete-{}", for_delete.as_str()).into()))
			.flex()
			.items_center()
			.justify_center()
			.size(px(20.0))
			.flex_none()
			.rounded(px(radius::PILL))
			.opacity(hover)
			.text_size(px(size::SMALL))
			.text_color(theme.text_faint)
			.cursor_pointer()
			.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
			.on_click(cx.listener(move |shell, _, _, cx| {
				moves::delete_session(&mut shell.store, &for_delete);
				shell.show_selected(cx);
				cx.notify();
			}))
			.child(ui::glyph::CLOSE)
	});

	div()
		.id(gpui::ElementId::Name(format!("row-{}", id.as_str()).into()))
		.flex()
		.flex_col()
		.gap(px(1.0))
		.w_full()
		.py(px(space::SNUG))
		.px(px(space::BASE))
		.rounded(px(radius::ROW))
		.bg(ground)
		.opacity(appearing)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(hover_key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.on_click(cx.listener(move |shell, _, _, cx| shell.select(&for_click, cx)))
		.child(
			ui::line_of(space::SNUG)
				.child(
					ui::line(title)
						.flex_1()
						.min_w(px(0.0))
						.text_size(px(size::SMALL))
						.text_color(if selected {
							theme.text
						} else {
							theme.text_muted
						})
						.when(selected, |element| element.font_weight(gpui::FontWeight::MEDIUM)),
				)
				.children(delete),
		)
		.when_some(preview, |element, preview| {
			element.child(
				ui::line(preview)
					.text_size(px(size::META))
					.text_color(theme.text_faint),
			)
		})
		.into_any_element()
}
