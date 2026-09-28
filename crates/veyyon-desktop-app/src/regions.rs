//! The six regions a window opens, each built over the one [`AppState`].
//!
//! The binary and the suites that open a whole window build their regions
//! here, so a region added to the window reaches both.

use gpui::{App, AppContext as _, Entity, Window};

use crate::{
	AppState, drawer::TerminalDrawer, palette::CommandPalette, panel::RightPanel,
	settings::SettingsView, sidebar::Sidebar, thread::ThreadView, workspace::Regions,
};

/// Constructs the sidebar, thread, right panel, terminal drawer, command
/// palette and settings over `app`.
pub fn build(app: &Entity<AppState>, window: &mut Window, cx: &mut App) -> Regions {
	Regions {
		sidebar:  cx.new(|cx| Sidebar::new(app.clone(), window, cx)).into(),
		thread:   cx.new(|cx| ThreadView::new(app.clone(), window, cx)).into(),
		panel:    cx.new(|cx| RightPanel::new(app.clone(), window, cx)).into(),
		drawer:   cx
			.new(|cx| TerminalDrawer::new(app.clone(), window, cx))
			.into(),
		palette:  cx
			.new(|cx| CommandPalette::new(app.clone(), window, cx))
			.into(),
		settings: cx
			.new(|cx| SettingsView::new(app.clone(), window, cx))
			.into(),
	}
}
