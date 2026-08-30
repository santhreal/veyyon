//! The session list, which is also the navigation.
//!
//! There is no tab strip. A session is reached from this list and the titlebar
//! names the one that is open, because a tab strip and a session list are two
//! controls for one choice, and the list is the one that can show what each
//! session is doing.
//!
//! HOW A ROW READS. Every title starts at the same x, whatever is to its left,
//! so the list scans as a column of names rather than as a ragged edge. What a
//! session is doing is a word at the right, in its colour; unread is the title
//! in a heavier weight rather than a dot, because a marker column is a column
//! of nothing for every session that has been read. A row recedes by default
//! and lifts under the pointer, where it also offers the one destructive thing
//! it can do, so nothing is offered until it is asked for.
//!
//! The order is `Store::rows`: what wants an answer, then what is running, then
//! by recency. Sorting by time alone buries the one session that stopped and is
//! waiting under every session that is still going.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, MouseButton, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	input::Editor,
	motion::{self, Channel, Key},
	shell::Shell,
	state::{
		model::{Activity, ProjectId, SessionId},
		moves,
	},
	theme::{Theme, radius, size, space},
	ui,
};

/// The column every title starts at, whatever glyph is to its left.
const GUTTER: f32 = 16.0;

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let waiting = shell.store.attention();
	let projects: Vec<(ProjectId, String, bool, usize, usize)> = shell
		.store
		.projects
		.iter()
		.map(|project| {
			(
				project.id.clone(),
				project.name.clone(),
				project.collapsed,
				shell.store.rows(&project.id).len(),
				shell.store.waiting(&project.id),
			)
		})
		.collect();

	let mut list = div()
		.id("sessions")
		.flex()
		.flex_col()
		.gap(px(space::LOOSE))
		.flex_1()
		.min_h(px(0.0))
		.overflow_y_scroll()
		.px(px(space::BASE))
		.pb(px(space::BASE));

	for (id, name, collapsed, count, project_waiting) in projects {
		list = list.child(group(shell, &id, &name, collapsed, count, project_waiting, cx));
	}

	div()
		.flex()
		.flex_col()
		.size_full()
		.min_w(px(0.0))
		.child(header(waiting, cx))
		.child(list)
		.child(ui::hairline(&theme))
		.child(footer(shell, cx))
}

/// The sidebar's own head: what the list is, and what is unanswered in it.
fn header(waiting: usize, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	ui::line_of(space::SNUG)
		.h(px(34.0))
		.flex_none()
		.px(px(space::WIDE))
		.child(ui::eyebrow("Sessions", &theme).flex_1())
		.when(waiting > 0, |element| {
			element.child(ui::chip(waiting.to_string(), theme.warning, &theme))
		})
}

/// The bottom of the list: the one control that is always reachable.
fn footer(shell: &mut Shell, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, "sidebar-new");
	let ground = ui::wash(&mut shell.motion, key, gpui::transparent_black(), theme.hover(), now);

	div()
		.id("new-session")
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.h(px(36.0))
		.flex_none()
		.mx(px(space::BASE))
		.my(px(space::SNUG))
		.px(px(space::BASE))
		.rounded(px(radius::ROW))
		.bg(ground)
		.cursor_pointer()
		.text_size(px(size::SMALL))
		.text_color(theme.text_muted)
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.on_click(cx.listener(|shell, _, window, cx| {
			moves::new_session(&mut shell.store);
			shell.pull_draft(cx);
			Editor::focus(&shell.composer, window, cx);
			cx.notify();
		}))
		.child(div().w(px(GUTTER)).child(ui::glyph::NEW))
		.child("New session")
}

/// One project: a foldable band with its rows.
fn group(
	shell: &mut Shell,
	project: &ProjectId,
	name: &str,
	collapsed: bool,
	count: usize,
	waiting: usize,
	cx: &mut Context<Shell>,
) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Group, project.as_str());
	// A folded band keeps its count, so folding hides the rows and not the
	// information that there are rows.
	let open = shell
		.motion
		.drive(key, motion::COLLAPSE, if collapsed { 0.0 } else { 1.0 }, now);

	let rows: Vec<SessionId> = shell
		.store
		.rows(project)
		.iter()
		.map(|session| session.id.clone())
		.collect();
	let mut band = div().flex().flex_col().gap(px(2.0));
	if open > 0.01 {
		for id in rows {
			band = band.child(row(shell, &id, cx));
		}
	}

	let for_click = project.clone();
	div()
		.flex()
		.flex_col()
		.child(
			div()
				.id(gpui::ElementId::Name(format!("group-{}", project.as_str()).into()))
				.flex()
				.items_center()
				.gap(px(space::TIGHT))
				.h(px(26.0))
				.px(px(space::TIGHT))
				.cursor_pointer()
				.text_size(px(size::MICRO))
				.text_color(theme.text_faint)
				.on_click(cx.listener(move |shell, _, _, cx| {
					moves::toggle_project(&mut shell.store, &for_click);
					cx.notify();
				}))
				.child(div().w(px(GUTTER)).child(if collapsed {
					ui::glyph::FOLDED
				} else {
					ui::glyph::OPEN
				}))
				.child(
					ui::line(name.to_uppercase())
						.flex_1()
						.min_w(px(0.0))
						.font_weight(gpui::FontWeight::SEMIBOLD),
				)
				.when(waiting > 0, |element| {
					element.child(div().text_color(theme.warning).child(waiting.to_string()))
				})
				.when(waiting == 0 && count > 0, |element| {
					element.child(div().child(count.to_string()))
				}),
		)
		// The band's own height is not animated: taffy would have to measure the
		// rows to tween it, and a list that squashes as it folds reads worse
		// than one that fades. The rows fade and the band closes with them.
		.when(open > 0.01, |element| element.child(div().opacity(open).child(band)))
}

/// One session.
fn row(shell: &mut Shell, id: &SessionId, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	let now = shell.now;
	let Some(session) = shell.store.session(id) else {
		return div().into_any_element();
	};

	let selected = shell.store.selected.as_ref() == Some(id);
	let title = session.title.clone();
	let preview = session.preview();
	let status = session.status;
	let unread = session.unread;
	let model = session.model.clone();

	let hover_key = Key::named(Channel::Row, id.as_str());
	let enter_key = Key::named(Channel::RowEnter, id.as_str());
	let hover = shell.motion.value(hover_key, now);
	let appearing = shell.motion.enter(enter_key, motion::ENTER, now);

	// A selected row is a fill; an unselected one is the ground until the
	// pointer arrives. Both are the same channel, so a row selected while
	// hovered does not jump.
	let rest = if selected {
		theme.selected()
	} else {
		gpui::transparent_black()
	};
	let ground = motion::mix(
		rest,
		if selected {
			theme.selected()
		} else {
			theme.hover()
		},
		hover,
	);

	// A session that wants an answer or has broken says so with a card; the
	// rest are slim rows. A list where every row is a card is a list with no
	// shape, and the shape is what makes the one that needs reading findable.
	let card = status.needs_answer() || selected;
	let glyph = match status {
		Activity::Waiting => ui::glyph::WAITING,
		Activity::Failed => ui::glyph::FAILED,
		Activity::Working => ui::glyph::WORKING,
		Activity::Done => ui::glyph::DONE,
		Activity::Idle => "",
	};
	let color = theme.activity(status);
	let phase = status
		.is_running()
		.then(|| shell.motion.phase(motion::SPIN_MS, now));

	let for_click = id.clone();
	let for_archive = id.clone();

	div()
		.id(gpui::ElementId::Name(format!("row-{}", id.as_str()).into()))
		.relative()
		.opacity(appearing)
		.flex()
		.items_start()
		.gap(px(space::TIGHT))
		.w_full()
		.py(px(if card { space::SNUG } else { space::TIGHT }))
		.px(px(space::SNUG))
		.rounded(px(radius::ROW))
		.bg(ground)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(hover_key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.on_click(cx.listener(move |shell, _, _, cx| {
			shell.select(&for_click, cx);
		}))
		// The glyph column. Fixed width whether or not there is a glyph, which
		// is what keeps every title on the same x.
		.child(
			div()
				.w(px(GUTTER))
				.flex_none()
				.text_size(px(size::MICRO))
				.text_color(color)
				.when_some(phase, |element, phase| {
					// A running session breathes rather than spins: one cell,
					// so it costs one opacity and no layout.
					element.opacity(0.45 + 0.55 * motion::wave(phase, 0, 1))
				})
				.child(glyph),
		)
		.child(
			div()
				.flex()
				.flex_col()
				.gap(px(1.0))
				.flex_1()
				.min_w(px(0.0))
				.child(
					ui::line(title)
						.text_size(px(size::BODY))
						.text_color(if unread { theme.text } else { theme.text_muted })
						.font_weight(if unread {
							gpui::FontWeight::SEMIBOLD
						} else {
							gpui::FontWeight::NORMAL
						}),
				)
				.when(card, |element| {
					element
						.when_some(preview, |element, preview| {
							element.child(
								ui::line(preview)
									.text_size(px(size::META))
									.text_color(theme.text_faint),
							)
						})
						.when(!model.is_empty(), |element| {
							element.child(
								ui::line(model)
									.text_size(px(size::MICRO))
									.text_color(theme.text_faint),
							)
						})
				}),
		)
		// The right shoulder: what it is doing, and under the pointer, the one
		// thing that can be done to it from here. They occupy the same space,
		// so neither costs the title any width.
		.child(
			div()
				.relative()
				.flex_none()
				.w(px(52.0))
				.h(px(16.0))
				.child(
					div()
						.absolute()
						.right_0()
						.top_0()
						.opacity(1.0 - hover)
						.text_size(px(size::MICRO))
						.text_color(color)
						.children(status.label()),
				)
				.child(
					div()
						.id(gpui::ElementId::Name(format!("archive-{}", id.as_str()).into()))
						.absolute()
						.right_0()
						.top_0()
						.opacity(hover)
						.text_size(px(size::MICRO))
						.text_color(theme.text_faint)
						.cursor_pointer()
						.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
						.on_click(cx.listener(move |shell, _, _, cx| {
							moves::archive(&mut shell.store, &for_archive);
							shell.pull_draft(cx);
							cx.notify();
						}))
						.child("Archive"),
				),
		)
		.into_any_element()
}
