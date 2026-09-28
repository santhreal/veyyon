//! The `workspace` actions: each changes the layout global, moves focus, or
//! queues a host request.

use gpui::{Context, InteractiveElement, Window};
use veyyon_desktop_model::{HostAction, SurfaceId};

use super::{FocusSlot, Workspace, WorkspaceLayout, focus_slot, geometry::Sizes};
use crate::actions::workspace as act;

impl Workspace {
	/// Registers a listener for every `workspace` action on `root`.
	pub(super) fn listen<E: InteractiveElement>(root: E, cx: &mut Context<Self>) -> E {
		root
			.on_action(cx.listener(|_, _: &act::ToggleSidebar, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.sidebar_visible = !layout.sidebar_visible);
			}))
			.on_action(cx.listener(|_, _: &act::TogglePanel, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.panel_open = !layout.panel_open);
			}))
			.on_action(cx.listener(|_, _: &act::ToggleDrawer, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.drawer_open = !layout.drawer_open);
			}))
			.on_action(cx.listener(|_, action: &act::ShowPanelTab, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.show_panel_tab(action.tab.clone()));
			}))
			.on_action(cx.listener(|_, _: &act::OpenPalette, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.palette_open = true);
			}))
			.on_action(cx.listener(|_, _: &act::ClosePalette, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.palette_open = false);
			}))
			.on_action(cx.listener(|_, _: &act::TogglePalette, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.palette_open = !layout.palette_open);
			}))
			.on_action(cx.listener(|_, action: &act::OpenSettings, _, cx| {
				WorkspaceLayout::update(cx, |layout| layout.open_settings(action.page.clone()));
			}))
			.on_action(cx.listener(|this, _: &act::CloseSettings, window, cx| {
				WorkspaceLayout::update(cx, |layout| {
					layout.settings_open = false;
					layout.settings_page = None;
				});
				this.focus_composer(window, cx);
			}))
			.on_action(cx.listener(|this, _: &act::FocusComposer, window, cx| {
				WorkspaceLayout::update(cx, |layout| {
					layout.settings_open = false;
					layout.palette_open = false;
				});
				this.focus_composer(window, cx);
			}))
			.on_action(cx.listener(|_, _: &act::SearchThreads, window, cx| {
				WorkspaceLayout::update(cx, |layout| layout.sidebar_visible = true);
				focus_slot(FocusSlot::SidebarSearch, window, cx);
			}))
			.on_action(cx.listener(|this, _: &act::ResetLayout, _, cx| {
				this.sizes = Sizes::default();
				this.report(cx);
				cx.notify();
			}))
			.on_action(cx.listener(|this, _: &act::NewThread, _, cx| {
				let workspace = {
					let app = this.app.read(cx);
					app.active_session()
						.and_then(|session| app.cwd(session))
						.map(str::to_owned)
				};
				this.send(
					HostAction::CreateSession { workspace, title: None },
					SurfaceId::NewSessionButton,
					cx,
				);
			}))
			.on_action(cx.listener(|this, _: &act::Attach, _, cx| {
				this.send(HostAction::Attach { endpoint: None }, SurfaceId::ConnectionAttachButton, cx);
			}))
			.on_action(cx.listener(|this, _: &act::Detach, _, cx| {
				this.send(HostAction::Detach, SurfaceId::ConnectionDetachButton, cx);
			}))
			.on_action(cx.listener(|this, _: &act::RetryConnection, _, cx| {
				this.send(HostAction::RetryConnection, SurfaceId::ConnectionRetryButton, cx);
			}))
			.on_action(cx.listener(|this, _: &act::Shutdown, _, cx| {
				this.send(HostAction::Shutdown, SurfaceId::ShutdownButton, cx);
			}))
			.on_action(|_: &act::Quit, _: &mut Window, cx| cx.quit())
	}

	fn send(&self, action: HostAction, surface: SurfaceId, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			app.dispatch(action, surface, cx);
		});
	}
}
