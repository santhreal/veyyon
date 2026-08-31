//! Responsive panel constraints and overlay unwind transitions.

use crate::{
	command::UiCommand,
	navigation::{Overlay, PanelPresentation, Route, SettingsPage},
	store::Store,
};

#[test]
fn escape_unwinds_one_layer_then_responsive_panels_then_settings() {
	let mut store = Store::detached();
	store.frontend.route = Route::Settings(SettingsPage::General);
	store.frontend.panels.sidebar_presentation = PanelPresentation::Sheet;
	store.frontend.panels.inspector_presentation = PanelPresentation::Sheet;
	store.frontend.panels.bottom_open = true;
	store.frontend.overlays.push(Overlay::QuickOpen);
	store.dispatch(UiCommand::CloseTopOverlay);
	assert!(store.frontend.overlays.is_empty());
	store.dispatch(UiCommand::CloseTopOverlay);
	assert!(!store.frontend.panels.inspector_open);
	store.dispatch(UiCommand::CloseTopOverlay);
	assert!(!store.frontend.panels.sidebar_open);
	store.dispatch(UiCommand::CloseTopOverlay);
	assert!(!store.frontend.panels.bottom_open);
	store.dispatch(UiCommand::CloseTopOverlay);
	assert_eq!(store.frontend.route, Route::Conversation);
}

#[test]
fn panel_constraints_change_presentation_without_losing_sizes() {
	let mut store = Store::detached();
	store.dispatch(UiCommand::ResizeSidebar { width_milli_px: 900_000 });
	store
		.dispatch(UiCommand::ConstrainPanels { width_milli_px: 850_000, height_milli_px: 600_000 });
	assert_eq!(store.frontend.panels.sidebar_width, 400.0);
	assert_eq!(store.frontend.panels.sidebar_presentation, PanelPresentation::Sheet);
	assert_eq!(store.frontend.panels.inspector_presentation, PanelPresentation::Sheet);
}
