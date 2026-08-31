//! WHY THIS SUITE EXISTS. A space must be an isolated workspace holding its own
//! named, ordered set of open tabs and its own panel layout. Switching between
//! spaces must restore the exact panel widths, dock states, and active tab
//! index configured in that space.
//!
//! What this closes: panel layout collisions and tab leakage across spaces.
//! What it does not catch: OS display geometry changes while switched away.

#[cfg(test)]
mod tests {
	use crate::{
		Store, UiCommand,
		model::SessionId,
		navigation::{BottomTab, InspectorTab},
	};

	fn sample_session_id(name: &str) -> SessionId {
		SessionId::new(name).unwrap()
	}

	#[test]
	fn switching_spaces_restores_tabs_and_panel_layout() {
		let mut store = Store::detached();
		let s1 = sample_session_id("session-space-1");
		let s2 = sample_session_id("session-space-2");

		// Space 1: Configure tabs and layout
		store.dispatch(UiCommand::OpenTab(s1.clone()));
		store.dispatch(UiCommand::ResizeSidebar { width_milli_px: 280_000 });
		store.dispatch(UiCommand::SetBottomTab(BottomTab::Terminals));
		store.dispatch(UiCommand::SetInspectorTab(InspectorTab::Context));

		let space_1_id = store.frontend.spaces.active_space_id().unwrap();
		assert_eq!(store.frontend.selected_session, Some(s1.clone()));
		assert_eq!(store.frontend.panels.sidebar_width, 280.0);
		assert_eq!(store.frontend.bottom_tab, BottomTab::Terminals);

		// Create and switch to Space 2
		store.dispatch(UiCommand::CreateSpace { name: "Project B".to_owned() });
		let space_2_id = store.frontend.spaces.active_space_id().unwrap();
		assert_ne!(space_1_id, space_2_id);

		// Space 2: Open tab s2, configure different layout
		store.dispatch(UiCommand::OpenTab(s2.clone()));
		store.dispatch(UiCommand::ResizeSidebar { width_milli_px: 360_000 });
		store.dispatch(UiCommand::SetBottomTab(BottomTab::Output));
		store.dispatch(UiCommand::SetInspectorTab(InspectorTab::Details));

		assert_eq!(store.frontend.selected_session, Some(s2.clone()));
		assert_eq!(store.frontend.panels.sidebar_width, 360.0);
		assert_eq!(store.frontend.bottom_tab, BottomTab::Output);
		assert_eq!(store.frontend.inspector_tab, InspectorTab::Details);

		// Switch back to Space 1: verify layout and active tab restored
		store.dispatch(UiCommand::SelectSpace(space_1_id.clone()));
		assert_eq!(store.frontend.selected_session, Some(s1.clone()));
		assert_eq!(store.frontend.panels.sidebar_width, 280.0);
		assert_eq!(store.frontend.bottom_tab, BottomTab::Terminals);
		assert_eq!(store.frontend.inspector_tab, InspectorTab::Context);
		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 1);

		// Switch back to Space 2: verify layout and active tab restored
		store.dispatch(UiCommand::SelectSpace(space_2_id));
		assert_eq!(store.frontend.selected_session, Some(s2));
		assert_eq!(store.frontend.panels.sidebar_width, 360.0);
		assert_eq!(store.frontend.bottom_tab, BottomTab::Output);
		assert_eq!(store.frontend.inspector_tab, InspectorTab::Details);
		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 1);
	}
}
