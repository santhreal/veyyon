//! The workspace's frame: sidebar, thread or settings over the drawer, right
//! panel, and the palette over all of them (CONTRACT §4). The connection
//! banner tops the thread column while the link is not up and the freeze
//! strip while the host holds every agent frozen, the empty state takes the
//! thread's place while no session is open, and the toast stack is drawn
//! over everything below the thread header, clear of the composer at the
//! column's foot and the drawer under it.
//!
//! A region slides by clipping a container of `size × open` around content
//! drawn at its full size and pinned to the container's fixed edge, so the
//! region keeps its layout while it moves and its cached view is not rebuilt
//! for the slide. A closed region at rest is not drawn.

use gpui::{
	AnyElement, AnyView, Axis, Context, InteractiveElement, IntoElement, ParentElement, Pixels,
	Render, StyleRefinement, Styled, Window, div, prelude::FluentBuilder,
};
use veyyon_desktop_ui::{
	overlays::SplitHandle,
	theme::{ActiveTheme, size},
};

use super::{Workspace, WorkspaceLayout, banner::ConnectionBanner};
use crate::driver;

impl Render for Workspace {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// A change of the system preference reaches the app as a redraw of
		// every window, so the frame resolves it before any driver samples.
		self.reduced.resolve(&self.app, cx);
		let open = self.slides.step(window, cx);
		let layout = WorkspaceLayout::get(cx).clone();
		let sizes = self.sizes;
		let palette = cx.theme().palette;

		let sidebar = (open.sidebar > 0.0)
			.then(|| slot("sidebar", &self.regions.sidebar, sizes.sidebar, open.sidebar, Edge::Right));
		let sidebar_handle = layout.sidebar_visible.then(|| {
			let this = cx.weak_entity();
			SplitHandle::new("workspace.sidebar-handle", Axis::Horizontal)
				.on_drag(move |delta, _, cx| {
					this
						.update(cx, |this, cx| this.resize(cx, |sizes| sizes.drag_sidebar(delta)))
						.ok();
				})
				.on_reset(reset(cx, |sizes| {
					sizes.sidebar = size::SIDEBAR;
					sizes.sidebar_set = false;
				}))
		});
		let panel = (open.panel > 0.0)
			.then(|| slot("panel", &self.regions.panel, sizes.panel, open.panel, Edge::Left));
		let panel_handle = layout.panel_open.then(|| {
			let this = cx.weak_entity();
			SplitHandle::new("workspace.panel-handle", Axis::Horizontal)
				.on_drag(move |delta, _, cx| {
					this
						.update(cx, |this, cx| this.resize(cx, |sizes| sizes.drag_panel(-delta)))
						.ok();
				})
				.on_reset(reset(cx, |sizes| {
					sizes.panel = size::PANEL;
					sizes.panel_set = false;
				}))
		});
		let drawer = (open.drawer > 0.0)
			.then(|| slot("drawer", &self.regions.drawer, sizes.drawer, open.drawer, Edge::Top));
		let drawer_handle = layout.drawer_open.then(|| {
			let this = cx.weak_entity();
			SplitHandle::new("workspace.drawer-handle", Axis::Vertical)
				.on_drag(move |delta, window, cx| {
					let height = window.viewport_size().height;
					this
						.update(cx, |this, cx| this.resize(cx, |sizes| sizes.drag_drawer(-delta, height)))
						.ok();
				})
				.on_reset(reset(cx, |sizes| {
					sizes.drawer = size::DRAWER;
					sizes.drawer_set = false;
				}))
		});
		let (no_session, banner, frozen) = {
			let app = self.app.read(cx);
			let store = app.store();
			(
				app.active_session().is_none(),
				ConnectionBanner::shows(&store.connection),
				store.paused.paused,
			)
		};
		let main = if layout.settings_open {
			driver::target("settings", fill(&self.regions.settings))
		} else if no_session {
			driver::target("empty", fill(&self.empty.clone().into()))
		} else {
			fill(&self.regions.thread)
		};
		let banner = banner.then(|| {
			driver::target(
				"connection-banner",
				self
					.banner
					.clone()
					.cached(StyleRefinement::default().w_full().h(size::HEADER))
					.into_any_element(),
			)
		});
		let freeze = frozen.then(|| {
			driver::target(
				"freeze",
				self
					.freeze
					.clone()
					.cached(StyleRefinement::default().w_full().h(size::HEADER))
					.into_any_element(),
			)
		});
		// A target not drawn this frame is dropped, so a client never reads the
		// bounds of a region that closed.
		for (id, drawn) in [
			("sidebar", sidebar.is_some()),
			("panel", panel.is_some()),
			("drawer", drawer.is_some()),
			("settings", layout.settings_open),
			("empty", !layout.settings_open && no_session),
			("connection-banner", banner.is_some()),
			("freeze", freeze.is_some()),
		] {
			if !drawn {
				driver::forget(window, id, cx);
			}
		}
		// The thread header sits under whichever strips top the column.
		let strips = 1 + u8::from(banner.is_some()) + u8::from(freeze.is_some());
		let toasts_top = size::HEADER * f32::from(strips);

		let root = div()
			.id("workspace")
			.key_context("Workspace")
			.track_focus(&self.focus)
			.relative()
			.size_full()
			.flex()
			.flex_row()
			.overflow_hidden()
			.bg(palette.bg.app)
			.text_color(palette.text.primary);
		Self::listen(root, cx)
			.children(sidebar)
			.children(sidebar_handle)
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w_0()
					.h_full()
					.children(banner)
					.children(freeze)
					.child(div().flex_1().min_h_0().child(main))
					.children(drawer_handle)
					.children(drawer),
			)
			.children(panel_handle)
			.children(panel)
			.child(
				div()
					.absolute()
					.inset_0()
					.child(fill(&self.regions.palette)),
			)
			.child(
				div()
					.absolute()
					.top(toasts_top)
					.left_0()
					.right_0()
					.bottom_0()
					.child(fill(&self.notices.toasts().clone().into())),
			)
			.when(driver::is_enabled(), |root| root.child(driver::FrameProbe))
	}
}

impl Workspace {
	/// Applies `change` to the sizes and reports the new layout.
	fn resize(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut super::Sizes)) {
		let before = self.sizes;
		change(&mut self.sizes);
		if self.sizes != before {
			self.report(cx);
			cx.notify();
		}
	}
}

/// A double-click handler that restores a size to its default with
/// `forget`.
fn reset(
	cx: &Context<Workspace>,
	forget: impl Fn(&mut super::Sizes) + 'static,
) -> impl Fn(&mut Window, &mut gpui::App) + 'static {
	let this = cx.weak_entity();
	move |_, cx| {
		this.update(cx, |this, cx| this.resize(cx, &forget)).ok();
	}
}

/// The edge of a region that stays put while it slides.
#[derive(Clone, Copy)]
enum Edge {
	/// The sidebar: its right edge meets the thread.
	Right,
	/// The panel: its left edge meets the thread.
	Left,
	/// The drawer: its top edge meets the thread.
	Top,
}

/// A region `size` wide (tall for [`Edge::Top`]) shown `open` of the way.
fn slot(id: &'static str, view: &AnyView, size: Pixels, open: f32, edge: Edge) -> AnyElement {
	let content = div().flex_none().map(|el| match edge {
		Edge::Top => el.w_full().h(size),
		Edge::Left | Edge::Right => el.h_full().w(size),
	});
	let clip = div()
		.flex()
		.flex_none()
		.overflow_hidden()
		.map(|el| match edge {
			Edge::Top => el.flex_col().w_full().h(size * open),
			Edge::Left => el.flex_row().h_full().w(size * open),
			Edge::Right => el.flex_row().justify_end().h_full().w(size * open),
		});
	driver::target(id, clip.child(content.child(fill(view))))
}

/// `view` drawn through its cache, filling its parent.
fn fill(view: &AnyView) -> AnyElement {
	let mut style = StyleRefinement::default();
	style.size.width = Some(gpui::relative(1.).into());
	style.size.height = Some(gpui::relative(1.).into());
	view.clone().cached(style).into_any_element()
}
