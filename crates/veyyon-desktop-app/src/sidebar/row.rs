//! The lines of the sidebar list and the thread row.

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
	listing::{Branches, Item},
	model::{Glyph, next_label_change_ms, relative_label},
};
use crate::{driver, state::SessionRow};

/// The group name a row's hover-only controls follow.
pub(super) const ROW_GROUP: &str = "sidebar-row";

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
			let Some(item) = self.items.get(ix) else {
				elements.push(div().h(size::ROW).into_any_element());
				continue;
			};
			let element = match item {
				Item::Block { block, count } => Some(self.block_header(*block, *count, ix, cx)),
				Item::Project(project) => projects
					.get(*project)
					.map(|listed| self.project_header(listed, ix, cx)),
				Item::Session { project, row, depth, branches } => projects
					.get(*project)
					.and_then(|listed| listed.sessions.get(*row))
					.map(|row| {
						next_change = next_change.min(next_label_change_ms(now, row.modified_at_ms));
						let glyph = Glyph::of(app.store(), row, now);
						let label = relative_label(now, row.modified_at_ms);
						self.session_row(row, (*depth, *branches), glyph, label, ix, cx)
					}),
				Item::Older(remaining) => Some(Self::older_row(*remaining, cx)),
			};
			let element = element.unwrap_or_else(|| div().h(size::ROW).into_any_element());
			elements.push(self.motion.place(item, projects, element));
		}
		self.arm_tick(next_change, cx);
		elements
	}

	fn session_row(
		&self,
		row: &SessionRow,
		(depth, branches): (usize, Branches),
		glyph: Glyph,
		label: String,
		ix: usize,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		// The open thread keeps the selected ground; a cursor the arrows moved
		// elsewhere is drawn as a hover, so moving it never claims an open.
		let open = self.app.read(cx).active_session() == Some(&row.id);
		let cursor = !open && self.selected.as_ref() == Some(&row.id);
		let naming = self
			.naming
			.as_ref()
			.filter(|naming| naming.is_session(&row.id));
		let confirming = self.confirm_delete.as_ref() == Some(&row.id);
		let (click_id, menu_id, more_id) = (row.id.clone(), row.id.clone(), row.id.clone());
		let fold_id = row.id.clone();
		let body: AnyElement = if let Some(naming) = naming {
			div()
				.flex_1()
				.min_w_0()
				.child(naming.editor.clone())
				.into_any_element()
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
				.when(depth > INDENT_LEVELS, |el| {
					el.child(
						div()
							.flex_none()
							.type_style(text::MICRO)
							.text_color(palette.text.faint)
							.child(format!("depth {depth}")),
					)
				})
				.when(branches != Branches::None, |el| {
					let folded = branches == Branches::Folded;
					el.child(
						div()
							.id(("sidebar-row-fold", ix))
							.flex_none()
							.tooltip(Tooltip::text(if folded {
								"Show branches"
							} else {
								"Hide branches"
							}))
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								cx.stop_propagation();
								this.toggle_fold(&fold_id, cx);
							}))
							.child(
								Icon::new(if folded {
									IconName::ChevronRight
								} else {
									IconName::ChevronDown
								})
								.size(size::ICON_SM)
								.color(palette.text.faint),
							),
					)
				})
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
			.pl(space::S2 + indent(depth))
			.pr(space::S2)
			.rounded(radius::MD)
			.type_style(text::UI)
			.when(open, |el| el.bg(palette.bg.selected).text_color(palette.text.primary))
			.when(cursor, |el| el.bg(palette.bg.hover).text_color(palette.text.primary))
			.when(!open && !cursor, move |el| {
				el.text_color(palette.text.secondary)
					.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
			})
			// A line sliding over another mid-motion shares its hitbox, so a
			// line's pointer handler stops the event: only the line drawn on
			// top takes it. On a right press that also keeps the sidebar from
			// taking focus back from the menu the press opened.
			.on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
				cx.stop_propagation();
				this.click_row(&click_id, event.click_count(), window, cx);
			}))
			.on_mouse_down(
				MouseButton::Right,
				cx.listener(move |this, event: &MouseDownEvent, window, cx| {
					cx.stop_propagation();
					this.open_row_menu(menu_id.clone(), event.position, window, cx);
				}),
			)
			.child(glyph_element(glyph, ix, &palette))
			.child(body)
			.when(naming.is_none() && !confirming, |el| {
				el.child(
					div()
						.absolute()
						.right(space::S1)
						.flex()
						.items_center()
						.gap(space::S0_5)
						.invisible()
						.group_hover(ROW_GROUP, |style| style.visible())
						.children(self.quick_placement(&row.id, ix, cx))
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

/// Levels a branch row is inset before the inset stops; a deeper row states
/// its depth in text instead.
const INDENT_LEVELS: usize = 2;

/// How far a branch row is inset: [`space::S3`] per level up to
/// [`INDENT_LEVELS`].
const fn indent(depth: usize) -> Pixels {
	match depth {
		0 => space::S0,
		1 => space::S3,
		_ => space::S6,
	}
}

/// The leading glyph of a thread row: a status dot with a tooltip stating it,
/// or an empty slot of the same width for an idle thread.
fn glyph_element(glyph: Glyph, ix: usize, palette: &Palette) -> AnyElement {
	let mark = match glyph {
		Glyph::Running(_) => StatusDot::new(DotStatus::Running).into_any_element(),
		Glyph::Waiting(_) => StatusDot::new(DotStatus::Waiting).into_any_element(),
		Glyph::Error => StatusDot::new(DotStatus::Error).into_any_element(),
		Glyph::Unread(_) => dot(palette.accent.base),
		Glyph::Idle => return div().flex_none().size(size::DOT).into_any_element(),
	};
	let slot = div().id(("sidebar-row-glyph", ix)).flex_none().child(mark);
	match glyph.label() {
		Some(label) => slot.tooltip(Tooltip::text(label)).into_any_element(),
		None => slot.into_any_element(),
	}
}

/// A [`size::DOT`] circle in `color`.
fn dot(color: Hsla) -> AnyElement {
	div()
		.flex_none()
		.size(size::DOT)
		.rounded_full()
		.bg(color)
		.into_any_element()
}
