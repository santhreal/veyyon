//! Where focus goes when a region holding it closes.
//!
//! A closed region leaves the frame, and a focus handle the frame no longer
//! holds dispatches every key and action from the window's root, which sits
//! above the workspace's own listeners: a region that kept focus as it closed
//! would leave the window's bindings reaching nothing.

use veyyon_gpui::{App, FocusHandle, Focusable, Window};

use crate::workspace::{FocusSlot, Workspace, focus_slot};

/// Moves focus out of `region` when it holds focus: to the composer, else to
/// the workspace.
pub fn release(region: &FocusHandle, window: &mut Window, cx: &mut App) {
	if !region.contains_focused(window, cx) || focus_slot(FocusSlot::Composer, window, cx) {
		return;
	}
	if let Some(Some(workspace)) = window.root::<Workspace>() {
		let handle = workspace.read(cx).focus_handle(cx);
		window.focus(&handle, cx);
	}
}
