//! One frame of the responsive shell body.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand};
use veyyon_gui_kit::theme::Theme;

use super::{
	activity_rail,
	hosts::{self, SheetSide},
	layout::{LayoutPlan, PanelSizes, Placement},
};

pub struct FrameSlots {
	pub sidebar_header: AnyElement,
	pub sidebar:        AnyElement,
	pub route_toolbar:  AnyElement,
	pub workspace:      AnyElement,
	pub inspector:      AnyElement,
	pub bottom:         AnyElement,
}

pub fn render_body(
	store: &Store,
	plan: LayoutPlan,
	sizes: PanelSizes,
	slots: FrameSlots,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let sidebar_width = sizes.sidebar;
	let inspector_width = sizes.inspector;
	let FrameSlots { sidebar_header, sidebar, route_toolbar, workspace, inspector, bottom } = slots;

	let sidebar_host = hosts::sidebar(sidebar_header, sidebar, sidebar_width, cx);
	let (sidebar_inline, sidebar_sheet) = match plan.sidebar {
		Placement::Inline => (Some(sidebar_host), None),
		Placement::Sheet => (
			None,
			Some(hosts::sheet(
				"sidebar-sheet",
				SheetSide::Left,
				sidebar_host,
				sidebar_width,
				UiCommand::ToggleSidebar,
				cx,
			)),
		),
		Placement::Hidden | Placement::Dock => (None, None),
	};
	let inspector_host = hosts::inspector(store, inspector, inspector_width, cx);
	let (inspector_inline, inspector_sheet) = match plan.inspector {
		Placement::Inline => (Some(inspector_host), None),
		Placement::Sheet => (
			None,
			Some(hosts::sheet(
				"inspector-sheet",
				SheetSide::Right,
				inspector_host,
				inspector_width,
				UiCommand::ToggleInspector,
				cx,
			)),
		),
		Placement::Hidden | Placement::Dock => (None, None),
	};
	let bottom_host = matches!(plan.bottom, Placement::Dock)
		.then(|| hosts::bottom_dock(store, bottom, sizes.bottom, cx));
	let center = div()
		.flex()
		.flex_col()
		.flex_1()
		.min_w(px(0.0))
		.min_h(px(0.0))
		.child(hosts::workspace(route_toolbar, workspace, cx))
		.children(bottom_host);
	let inline = div()
		.flex()
		.flex_1()
		.min_w(px(0.0))
		.min_h(px(0.0))
		.overflow_hidden()
		.children(sidebar_inline)
		.child(center)
		.children(inspector_inline);

	let top_sheet = inspector_sheet.or(sidebar_sheet);

	div()
		.id("shell-body")
		.relative()
		.flex()
		.flex_1()
		.min_h(px(0.0))
		.w_full()
		.bg(theme.canvas)
		.child(activity_rail::render(store, cx))
		.child(inline)
		.children(top_sheet)
		.into_any_element()
}
