//! The App-level listener of the sidebar's window actions, so the palette
//! reaches the sidebar wherever the focus is.

use gpui::{AnyWindowHandle, App, Global, WeakEntity};

use super::Sidebar;
use crate::actions::sidebar as act;

/// The sidebar the App-level sidebar actions reach, and the window it draws
/// in.
pub(super) struct SidebarHandle {
	pub(super) sidebar: WeakEntity<Sidebar>,
	pub(super) window:  AnyWindowHandle,
}

impl Global for SidebarHandle {}

/// Registers the sidebar's App-level action listeners.
pub fn init(cx: &mut App) {
	cx.on_action(|_: &act::OpenProfileMenu, cx| {
		let Some(handle) = cx.try_global::<SidebarHandle>() else {
			return;
		};
		let (sidebar, window) = (handle.sidebar.clone(), handle.window);
		// An App-level listener runs inside the window's own update, so the
		// menu, which takes focus, opens once that update has returned.
		cx.defer(move |cx| {
			let _ = window.update(cx, |_, window, cx| {
				let _ = sidebar.update(cx, |sidebar, cx| sidebar.request_profile_menu(window, cx));
			});
		});
	});
}
