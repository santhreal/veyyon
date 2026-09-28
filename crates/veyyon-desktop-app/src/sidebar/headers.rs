//! The header lines of the sidebar list: a block header, a project header and
//! the archive's `Older` line.

use gpui::{AnyElement, ClickEvent, Context, div, prelude::*};
use veyyon_desktop_ui::{
	controls::{IconButton, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::{Sidebar, listing::Block, row::ROW_GROUP};
use crate::{driver, state::Project};

impl Sidebar {
	pub(super) fn block_header(
		&self,
		block: Block,
		count: usize,
		ix: usize,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let closed = self.folded.is_empty() && self.app.read(cx).is_section_collapsed(block.key());
		let element = div()
			.id(("sidebar-block", ix))
			.flex()
			.items_center()
			.gap(space::S1_5)
			.h(size::ROW)
			.px(space::S2)
			.rounded(radius::MD)
			.type_style(text::SMALL)
			.text_color(palette.text.faint)
			.hover(move |style| {
				style
					.bg(palette.bg.hover)
					.text_color(palette.text.secondary)
			})
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
				// Only the line drawn on top takes a click (see `row.rs`).
				cx.stop_propagation();
				this.toggle_block(block, cx);
			}))
			.child(
				Icon::new(if closed {
					IconName::ChevronRight
				} else {
					IconName::ChevronDown
				})
				.size(size::ICON_SM)
				.color(palette.text.faint),
			)
			.child(div().flex_1().min_w_0().truncate().child(block.label()))
			.child(div().flex_none().child(count.to_string()));
		driver::target(("sidebar.block", block.key()), element)
	}

	/// The line under the archived threads that lists the next page.
	pub(super) fn older_row(remaining: usize, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let element = div()
			.id("sidebar-older")
			.flex()
			.items_center()
			.gap(space::S1_5)
			.h(size::ROW)
			.px(space::S2)
			.rounded(radius::MD)
			.type_style(text::SMALL)
			.text_color(palette.text.faint)
			.hover(move |style| {
				style
					.bg(palette.bg.hover)
					.text_color(palette.text.secondary)
			})
			.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
				cx.stop_propagation();
				this.show_older(cx);
			}))
			.child(
				Icon::new(IconName::ChevronDown)
					.size(size::ICON_SM)
					.color(palette.text.faint),
			)
			.child(format!("Older ({remaining} remaining)"));
		driver::target("sidebar.older", element)
	}

	pub(super) fn project_header(
		&self,
		project: &Project,
		ix: usize,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let collapsed =
			self.folded.is_empty() && self.app.read(cx).is_project_collapsed(&project.path);
		let path = project.path.clone();
		let new_in = project.path.clone();
		let element = div()
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
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
				cx.stop_propagation();
				this.toggle_project(&path, cx);
			}))
			.child(
				Icon::new(if collapsed {
					IconName::ChevronRight
				} else {
					IconName::ChevronDown
				})
				.size(size::ICON_SM)
				.color(palette.text.faint),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.child(project.name.clone()),
			)
			.child(
				div()
					.invisible()
					.group_hover(ROW_GROUP, |style| style.visible())
					.child(
						IconButton::new(("sidebar-project-new", ix), IconName::Plus)
							.tooltip(format!("New thread in {}", project.name))
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								cx.stop_propagation();
								let cwd = Some(new_in.clone());
								this.app.update(cx, |app, cx| app.create_session(cwd, cx));
							})),
					),
			);
		driver::target(("sidebar.project", project.path.as_str()), element)
	}
}
