//! Global shell navigation decisions.

use veyyon_gui_core::{
	UiCommand,
	navigation::{FrontendState, Route},
};

use super::layout::{LayoutPlan, PanelSizes, Placement};

/// The single layer removed by Escape.
///
/// Overlays are last-in-first-out in core. Responsive sheets follow, then the
/// dock, then settings navigation. Inline context panels are layout, not modal
/// layers, so Escape does not make a wide window rearrange itself.
pub fn escape_command(frontend: &FrontendState, width: f32) -> Option<UiCommand> {
	if !frontend.overlays.is_empty() {
		return Some(UiCommand::CloseTopOverlay);
	}
	// Rest sizes, not the sizes a frame is drawing: Escape acts on the layer the
	// panels have settled on, so a keystroke during an animation removes the same
	// layer it would a moment later.
	let plan = LayoutPlan::resolve(width, PanelSizes::rest(&frontend.panels));
	if matches!(plan.inspector, Placement::Sheet) {
		return Some(UiCommand::ToggleInspector);
	}
	if matches!(plan.sidebar, Placement::Sheet) {
		return Some(UiCommand::ToggleSidebar);
	}
	if frontend.panels.bottom_open {
		return Some(UiCommand::ToggleBottomDock);
	}
	matches!(frontend.route, Route::Settings(_)).then_some(UiCommand::Navigate(Route::Conversation))
}
