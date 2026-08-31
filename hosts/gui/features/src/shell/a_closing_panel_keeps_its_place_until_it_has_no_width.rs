//! WHY: a panel's size was retargeted into the motion registry and then read
//! from the store, so the registry's value reached nothing on screen. A panel
//! snapped between open and closed, and the three tracks it wrote were never
//! sampled by anyone.
//!
//! The class this closes is placement disagreeing with size. A region is placed
//! for the size the frame draws it at, so a panel keeps its surface while its
//! size drains and loses it on the frame the size reaches zero. Every panel is
//! covered, at every breakpoint the responsive layout distinguishes, because a
//! rule applied to the sidebar and not the inspector is the recurring defect
//! here.
//!
//! Not covered: the pixels, and the registry's own retention policy, which the
//! kit's motion tests own.

use veyyon_gui_core::navigation::PanelState;
use veyyon_gui_kit::theme::{ResponsiveLayout, layout};

use super::layout::{LayoutPlan, PanelSizes, Placement};

/// Widths that reach each responsive layout, resolved from the breakpoints
/// rather than written here, with the match forcing a decision when a new
/// layout appears.
fn widths() -> Vec<(ResponsiveLayout, f32)> {
	[400.0, 1_000.0, 1_600.0]
		.into_iter()
		.map(|width| (veyyon_gui_kit::theme::responsive_layout(width), width))
		.map(|(responsive, width)| match responsive {
			ResponsiveLayout::Inline
			| ResponsiveLayout::InspectorSheet
			| ResponsiveLayout::SidebarAndInspectorSheets => (responsive, width),
		})
		.collect()
}

fn open() -> PanelState {
	PanelState {
		sidebar_open: true,
		inspector_open: true,
		bottom_open: true,
		..PanelState::default()
	}
}

fn closed() -> PanelState {
	PanelState {
		sidebar_open: false,
		inspector_open: false,
		bottom_open: false,
		..PanelState::default()
	}
}

#[test]
fn every_responsive_layout_is_reachable_by_one_of_the_widths_under_test() {
	let reached: Vec<ResponsiveLayout> = widths().into_iter().map(|(layout, _)| layout).collect();
	assert!(reached.contains(&ResponsiveLayout::Inline));
	assert!(reached.contains(&ResponsiveLayout::InspectorSheet));
	assert!(reached.contains(&ResponsiveLayout::SidebarAndInspectorSheets));
}

#[test]
fn a_panel_with_no_width_is_not_placed_at_any_breakpoint() {
	for (responsive, width) in widths() {
		let plan =
			LayoutPlan::resolve(width, PanelSizes { sidebar: 0.0, inspector: 0.0, bottom: 0.0 });
		assert_eq!(plan.responsive, responsive);
		assert_eq!(plan.sidebar, Placement::Hidden, "sidebar at {width}");
		assert_eq!(plan.inspector, Placement::Hidden, "inspector at {width}");
		assert_eq!(plan.bottom, Placement::Hidden, "dock at {width}");
	}
}

#[test]
fn a_panel_still_draining_is_placed_at_every_breakpoint() {
	for (_, width) in widths() {
		let plan =
			LayoutPlan::resolve(width, PanelSizes { sidebar: 12.0, inspector: 9.0, bottom: 4.0 });
		assert_ne!(plan.sidebar, Placement::Hidden, "sidebar at {width}");
		assert_ne!(plan.inspector, Placement::Hidden, "inspector at {width}");
		assert_eq!(plan.bottom, Placement::Dock, "dock at {width}");
	}
}

#[test]
fn the_last_sliver_of_a_panel_leaves_with_it() {
	// The threshold is a subpixel, so the frame that reaches it is the frame the
	// surface leaves the tree rather than one that draws a zero-width box.
	let sliver =
		LayoutPlan::resolve(1_600.0, PanelSizes { sidebar: 0.4, inspector: 0.4, bottom: 0.4 });
	assert_eq!(sliver.sidebar, Placement::Hidden);
	assert_eq!(sliver.inspector, Placement::Hidden);
	assert_eq!(sliver.bottom, Placement::Hidden);
	let visible =
		LayoutPlan::resolve(1_600.0, PanelSizes { sidebar: 0.6, inspector: 0.6, bottom: 0.6 });
	assert_eq!(visible.sidebar, Placement::Inline);
	assert_eq!(visible.inspector, Placement::Inline);
	assert_eq!(visible.bottom, Placement::Dock);
}

#[test]
fn a_closed_panel_rests_at_no_size_and_an_open_one_at_its_stored_size() {
	let rest = PanelSizes::rest(&closed());
	let panels = PanelState::default();
	// A closed panel rests at no size, which is what makes the drawn size the
	// only thing placement has to read.
	assert_eq!(rest.sidebar, 0.0);
	assert_eq!(rest.inspector, 0.0);
	assert_eq!(rest.bottom, 0.0);

	let sizes = PanelSizes::rest(&open());
	assert_eq!(sizes.sidebar, panels.sidebar_width);
	assert_eq!(sizes.inspector, panels.inspector_width);
	assert_eq!(sizes.bottom, panels.bottom_height);
}

#[test]
fn an_open_panel_rests_inside_the_range_the_layout_allows() {
	let mut panels = open();
	panels.sidebar_width = 10_000.0;
	panels.inspector_width = 10_000.0;
	let wide = PanelSizes::rest(&panels);
	assert_eq!(wide.sidebar, layout::SIDEBAR_MAX);
	assert_eq!(wide.inspector, layout::INSPECTOR_MAX);

	panels.sidebar_width = 1.0;
	panels.inspector_width = 1.0;
	let narrow = PanelSizes::rest(&panels);
	assert_eq!(narrow.sidebar, layout::SIDEBAR_MIN);
	assert_eq!(narrow.inspector, layout::INSPECTOR_MIN);
}
