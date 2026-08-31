//! Responsive placement and animated size for persistent shell regions.
//!
//! This module changes where a region is drawn and how wide or tall it is
//! drawn, never which retained surface supplies it. The app therefore keeps one
//! handle per region while this value moves the same surface between inline and
//! sheet containers.

use gpui::App;
use veyyon_gui_core::navigation::PanelState;
use veyyon_gui_kit::{
	motion::{MotionKey, OwnerNamespace, Property, RetainedKey, owner},
	paint,
	theme::{ResponsiveLayout, layout, responsive_layout},
};

/// The motion owner each panel's size animates under.
///
/// The shell retargets these when a panel opens or closes and commits them
/// directly while one is dragged; `PanelSizes` samples them. Both sides resolve
/// the owner here, so a panel cannot animate under one key and draw from
/// another.
fn sidebar() -> RetainedKey {
	owner(OwnerNamespace::Shell, "panel", "sidebar")
}

fn inspector() -> RetainedKey {
	owner(OwnerNamespace::Shell, "panel", "inspector")
}

fn bottom() -> RetainedKey {
	owner(OwnerNamespace::Shell, "panel", "bottom")
}

pub fn sidebar_width() -> MotionKey {
	MotionKey::new(sidebar(), Property::Width)
}

pub fn inspector_width() -> MotionKey {
	MotionKey::new(inspector(), Property::Width)
}

pub fn bottom_height() -> MotionKey {
	MotionKey::new(bottom(), Property::Height)
}

/// Below this a panel occupies no space and is not drawn at all. A closing
/// panel crosses it on its last frame, which is the frame its surface leaves
/// the tree.
const VISIBLE: f32 = 0.5;

/// The size each panel is drawn at this frame.
///
/// `rest` is where a panel sits with nothing animating: zero when it is closed,
/// its stored size clamped to the range the layout allows when it is open. The
/// drawn size is the motion registry's value for that property, so a panel
/// keeps its surface and drains its width across the frames after it closes
/// instead of vanishing between two.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelSizes {
	pub sidebar:   f32,
	pub inspector: f32,
	pub bottom:    f32,
}

impl PanelSizes {
	pub fn rest(panels: &PanelState) -> Self {
		Self {
			sidebar:   extent(
				panels.sidebar_open,
				panels.sidebar_width,
				layout::SIDEBAR_MIN,
				layout::SIDEBAR_MAX,
			),
			inspector: extent(
				panels.inspector_open,
				panels.inspector_width,
				layout::INSPECTOR_MIN,
				layout::INSPECTOR_MAX,
			),
			// The dock's height is constrained against the viewport when it is
			// stored, so there is no second range to clamp it to here.
			bottom:    if panels.bottom_open {
				panels.bottom_height
			} else {
				0.0
			},
		}
	}

	pub fn sample(panels: &PanelState, cx: &mut App) -> Self {
		let rest = Self::rest(panels);
		Self {
			sidebar:   paint::sample(cx, sidebar_width(), rest.sidebar),
			inspector: paint::sample(cx, inspector_width(), rest.inspector),
			bottom:    paint::sample(cx, bottom_height(), rest.bottom),
		}
	}
}

fn extent(open: bool, size: f32, min: f32, max: f32) -> f32 {
	if open { size.clamp(min, max) } else { 0.0 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
	Hidden,
	Inline,
	Sheet,
	Dock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutPlan {
	pub responsive: ResponsiveLayout,
	pub sidebar:    Placement,
	pub inspector:  Placement,
	pub bottom:     Placement,
}

impl LayoutPlan {
	/// Place each region for a viewport width and the sizes this frame draws.
	///
	/// A region is placed while it occupies space, not while its state says
	/// open: that is what keeps a closing panel in the tree for the frames its
	/// size takes to reach zero.
	pub fn resolve(width: f32, sizes: PanelSizes) -> Self {
		let responsive = responsive_layout(width);
		let sidebar = if sizes.sidebar <= VISIBLE {
			Placement::Hidden
		} else if matches!(responsive, ResponsiveLayout::SidebarAndInspectorSheets) {
			Placement::Sheet
		} else {
			Placement::Inline
		};
		let inspector = if sizes.inspector <= VISIBLE {
			Placement::Hidden
		} else if matches!(responsive, ResponsiveLayout::Inline) {
			Placement::Inline
		} else {
			Placement::Sheet
		};
		let bottom = if sizes.bottom > VISIBLE {
			Placement::Dock
		} else {
			Placement::Hidden
		};
		Self { responsive, sidebar, inspector, bottom }
	}

	pub const fn has_modal_sheet(self) -> bool {
		matches!(self.inspector, Placement::Sheet) || matches!(self.sidebar, Placement::Sheet)
	}
}
