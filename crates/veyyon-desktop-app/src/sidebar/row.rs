//! The lines of the sidebar list: a project header and a thread row.

use std::ops::Range;

use gpui::{
	AnyElement, ClickEvent, Context, Hsla, MouseButton, MouseDownEvent, Pixels, Window, div,
	prelude::*,
};
use veyyon_desktop_model::SessionId;
use veyyon_desktop_ui::{
	controls::{DotStatus, IconButton, StatusDot, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

use super::{
	Sidebar,
	model::{Glyph, Item, next_label_change_ms, relative_label},
};
use crate::{driver, state::Project, state::SessionRow};

/// The group name a thread row's hover-only controls follow.
const ROW_GROUP: &str = "sidebar-row";

impl Sidebar {
	/// The elements of list lines `range`, and the label timer armed to the
	/// next change of a drawn time label.
	pub(super) fn render_items(
		&mut self,
		range: Range<usize>,
		_window: &mut Window,
		cx: &Context<Self>,
	) -> Vec<AnyElement> {
		let now = (self.clock)();
		let mut next_change = u64::MAX;
		let mut elements = Vec::with_capacity(range.len());
		let app = self.app.read(cx);
		let projects = app.projects();
		for ix in range {
			let element = match self.items.get(ix) {
				Some(Item::Project(project)) => {
					projects.get(*project).map(|listed| self.project_header(listed, ix, cx))
				},
				Some(Item::Session { project, row }) => projects
					.get(*project)
					.and_then(|listed| listed.sessions.get(*row))
					.map(|row| {
						next_change = next_change.min(next_label_change_ms(now, row.modified_at_ms));
						let glyph = Glyph::of(app.store(), row, now);
						self.session_row(row, glyph, relative_label(now, row.modified_at_ms), ix, cx)
					}),
				None => None,
			};
			elements.push(element.unwrap_or_else(|| div().h(size::ROW).into_any_element()));
		}
		self.arm_tick(next_change, cx);
		elements
	}

	fn project_header(&self, project: &Project, ix: usize, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let collapsed = self.folded.is_empty() && self.collapsed.contains(&project.path);
		let path = project.path.clone();
		let new_in = project.path.clone();
		div()
			.id(("sidebar-project", ix))
			.group(ROW_GROUP)
			.flex()
			.items_center()
			.gap(space::S1_5)
			.h(size::ROW)
			.px(space::S2)
			.rounded(radius::MD)
			.type_style(text::UI_MEDIUM)
			.text_color(palette.text.muted)
			.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
			.tooltip(Tooltip::text(project.path.clone()))
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_project(&path, cx)))
			.child(
				Icon::new(if collapsed { IconName::ChevronRight } else { IconName::ChevronDown })
					.size(size::ICON_SM)
					.color(palette.text.faint),
			)
			.child(div().flex_1().min_w_0().truncate().child(project.name.clone()))
			.child(
				div().invisible().group_hover(ROW_GROUP, |style| style.visible()).child(
					IconButton::new(("sidebar-project-new", ix), IconName::Plus)
						.tooltip(format!("New thread in {}", project.name))
						.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
							cx.stop_propagation();
							let cwd = Some(new_in.clone());
							this.app.update(cx, |app, cx| app.create_session(cwd, cx));
						})),
				),
			)
			.into_any_element()
	}

	fn session_row(
		&self,
		row: &SessionRow,
		glyph: Glyph,
		label: String,
		ix: usize,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let selected = self.selected.as_ref() == Some(&row.id);
		let naming = self.naming.as_ref().filter(|naming| naming.is_session(&row.id));
		let confirming = self.confirm_delete.as_ref() == Some(&row.id);
		let (click_id, menu_id, more_id) = (row.id.clone(), row.id.clone(), row.id.clone());
		let body: AnyElement = if let Some(naming) = naming {
			div().flex_1().min_w_0().child(naming.editor.clone()).into_any_element()
		} else if confirming {
			Self::confirm_controls(&row.id, ix, &palette, cx)
		} else {
			div()
				.flex_1()
				.min_w_0()
				.flex()
				.items_center()
				.gap(space::S2)
				.child(div().flex_1().min_w_0().truncate().child(row.title.clone()))
				.child(
					div()
						.flex_none()
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.group_hover(ROW_GROUP, |style| style.invisible())
						.child(label),
				)
				.into_any_element()
		};
		let element = div()
			.id(("sidebar-row", ix))
			.group(ROW_GROUP)
			.relative()
			.flex()
			.items_center()
			.gap(space::S2)
			.h(size::ROW)
			.pl(space::S2 + indent(row.depth))
			.pr(space::S2)
			.rounded(radius::MD)
			.type_style(text::UI)
			.when(selected, |el| el.bg(palette.bg.selected).text_color(palette.text.primary))
			.when(!selected, move |el| {
				el.text_color(palette.text.secondary)
					.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
			})
			.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
				this.click_row(&click_id, event.click_count(), window, cx);
			}))
			.on_mouse_down(
				MouseButton::Right,
				cx.listener(move |this, event: &MouseDownEvent, window, cx| {
					this.open_row_menu(menu_id.clone(), event.position, window, cx);
				}),
			)
			.child(glyph_element(glyph, &palette))
			.child(body)
			.when(naming.is_none() && !confirming, |el| {
				el.child(
					div()
						.absolute()
						.right(space::S1)
						.invisible()
						.group_hover(ROW_GROUP, |style| style.visible())
						.child(
							IconButton::new(("sidebar-row-more", ix), IconName::Ellipsis)
								.tooltip("Thread actions")
								.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
									cx.stop_propagation();
									this.open_row_menu(more_id.clone(), event.position(), window, cx);
								})),
						),
				)
			});
		driver::target(("sidebar.row", row.id.0.as_str()), element)
	}

	fn confirm_controls(
		session: &SessionId,
		ix: usize,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let delete = session.clone();
		div()
			.flex_1()
			.min_w_0()
			.flex()
			.items_center()
			.gap(space::S1)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.text_color(palette.status.error)
					.child("Delete thread?"),
			)
			.child(
				IconButton::new(("sidebar-row-delete", ix), IconName::Trash2)
					.tooltip("Delete")
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
						cx.stop_propagation();
						this.confirm_delete(&delete, cx);
					})),
			)
			.child(
				IconButton::new(("sidebar-row-keep", ix), IconName::X)
					.tooltip("Cancel")
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
						cx.stop_propagation();
						this.confirm_delete = None;
						cx.notify();
					})),
			)
			.into_any_element()
	}
}

/// How far a branch row is inset: [`space::S3`] per level.
const fn indent(depth: usize) -> Pixels {
	match depth {
		0 => space::S0,
		1 => space::S3,
		_ => space::S6,
	}
}

/// The leading glyph of a thread row: a status dot, or an empty slot of the
/// same width for an idle thread.
fn glyph_element(glyph: Glyph, palette: &Palette) -> AnyElement {
	let status = match glyph {
		Glyph::Running => Some(DotStatus::Running),
		Glyph::Waiting => Some(DotStatus::Waiting),
		Glyph::Error => Some(DotStatus::Error),
		Glyph::Unread => None,
		Glyph::Idle => return div().flex_none().size(size::DOT).into_any_element(),
	};
	match status {
		Some(status) => StatusDot::new(status).into_any_element(),
		None => dot(palette.accent.base),
	}
}

/// A [`size::DOT`] circle in `color`.
fn dot(color: Hsla) -> AnyElement {
	div().flex_none().size(size::DOT).rounded_full().bg(color).into_any_element()
}
