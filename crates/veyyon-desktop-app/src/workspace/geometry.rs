//! The sizes of the resizable regions and the motion that opens and closes
//! them.
//!
//! Each region shows `size × open`, where `open` runs from 0 (closed) to 1
//! (open) on the [`motion::REGION`] spring. The spring is retargeted, never
//! restarted, so a toggle during a slide reverses from where the region is
//! with the velocity it has. Under reduced motion `open` lands at once.

use gpui::{
	App, Pixels, Window,
	motion::{Animator, FrameInstant, MotionDriver},
	px,
};
use veyyon_desktop_model::PanelsStore;
use veyyon_desktop_ui::theme::{motion, size};

use super::layout::WorkspaceLayout;

/// The share of the window height the drawer may take.
const DRAWER_MAX_SHARE: f32 = 0.7;

/// The sizes the regions open to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sizes {
	/// The sidebar width.
	pub sidebar:     Pixels,
	/// The right panel width.
	pub panel:       Pixels,
	/// The terminal drawer height.
	pub drawer:      Pixels,
	/// The sidebar was resized by hand.
	pub sidebar_set: bool,
	/// The panel was resized by hand.
	pub panel_set:   bool,
	/// The drawer was resized by hand.
	pub drawer_set:  bool,
}

impl Default for Sizes {
	fn default() -> Self {
		Self {
			sidebar:     size::SIDEBAR,
			panel:       size::PANEL,
			drawer:      size::DRAWER,
			sidebar_set: false,
			panel_set:   false,
			drawer_set:  false,
		}
	}
}

impl Sizes {
	/// Resizes the sidebar by `delta`, within its bounds.
	pub fn drag_sidebar(&mut self, delta: Pixels) {
		self.sidebar = (self.sidebar + delta).clamp(size::SIDEBAR_MIN, size::SIDEBAR_MAX);
		self.sidebar_set = true;
	}

	/// Resizes the panel by `delta`, within its bounds.
	pub fn drag_panel(&mut self, delta: Pixels) {
		self.panel = (self.panel + delta).clamp(size::PANEL_MIN, size::PANEL_MAX);
		self.panel_set = true;
	}

	/// Resizes the drawer by `delta`, within its bounds in a window
	/// `window_height` tall.
	pub fn drag_drawer(&mut self, delta: Pixels, window_height: Pixels) {
		self.drawer = (self.drawer + delta).clamp(size::DRAWER_MIN, drawer_max(window_height));
		self.drawer_set = true;
	}

	/// The sizes and layout `store` records, over the defaults.
	#[must_use]
	pub fn restore(store: &PanelsStore, layout: &mut WorkspaceLayout) -> Self {
		let mut sizes = Self::default();
		if let Some(width) = store.queue_width {
			sizes.sidebar = pixels(width).clamp(size::SIDEBAR_MIN, size::SIDEBAR_MAX);
			sizes.sidebar_set = true;
		}
		if let Some(width) = store.right_panel_width {
			sizes.panel = pixels(width).clamp(size::PANEL_MIN, size::PANEL_MAX);
			sizes.panel_set = true;
		}
		if let Some(height) = store.drawer_height {
			sizes.drawer = pixels(height).max(size::DRAWER_MIN);
			sizes.drawer_set = true;
		}
		layout.panel_open = store.right_panel_visible;
		layout.drawer_open = store.drawer_visible;
		if let Some(tab) = &store.active_right_tab {
			layout.panel_tab = tab.clone().into();
		}
		sizes
	}

	/// Writes the sizes and `layout` into `store`, keeping its other fields.
	/// A size never set by hand is written as absent.
	pub fn record(&self, layout: &WorkspaceLayout, store: &mut PanelsStore) {
		store.queue_width = self.sidebar_set.then(|| whole(self.sidebar));
		store.right_panel_width = self.panel_set.then(|| whole(self.panel));
		store.drawer_height = self.drawer_set.then(|| whole(self.drawer));
		store.right_panel_visible = layout.panel_open;
		store.drawer_visible = layout.drawer_open;
		store.active_right_tab = Some(layout.panel_tab.to_string());
	}
}

/// The tallest the drawer may be in a window `window_height` tall.
fn drawer_max(window_height: Pixels) -> Pixels {
	(window_height * DRAWER_MAX_SHARE).max(size::DRAWER_MIN)
}

#[expect(clippy::cast_precision_loss, reason = "a stored size is far below 2^24 pixels")]
const fn pixels(value: u32) -> Pixels {
	px(value as f32)
}

#[expect(
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss,
	reason = "a clamped size is positive and far below u32::MAX"
)]
fn whole(value: Pixels) -> u32 {
	f32::from(value).round().max(0.0) as u32
}

/// How far open each region is.
pub struct Slides {
	sidebar: Animator<FrameInstant>,
	panel:   Animator<FrameInstant>,
	drawer:  Animator<FrameInstant>,
	driver:  MotionDriver,
}

/// How far open each region is on this frame, 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Openness {
	/// The sidebar.
	pub sidebar: f32,
	/// The right panel.
	pub panel:   f32,
	/// The terminal drawer.
	pub drawer:  f32,
}

impl Slides {
	/// Regions resting where `layout` puts them.
	#[must_use]
	pub fn new(layout: &WorkspaceLayout) -> Self {
		Self {
			sidebar: Animator::at_rest(unit(layout.sidebar_visible)),
			panel:   Animator::at_rest(unit(layout.panel_open)),
			drawer:  Animator::at_rest(unit(layout.drawer_open)),
			driver:  MotionDriver::default(),
		}
	}

	/// Moves each region whose visibility differs between `from` and `to`
	/// toward where `to` puts it.
	pub fn retarget(&mut self, from: &WorkspaceLayout, to: &WorkspaceLayout, cx: &App) {
		if from.sidebar_visible != to.sidebar_visible {
			drive(&mut self.sidebar, unit(to.sidebar_visible), cx);
		}
		if from.panel_open != to.panel_open {
			drive(&mut self.panel, unit(to.panel_open), cx);
		}
		if from.drawer_open != to.drawer_open {
			drive(&mut self.drawer, unit(to.drawer_open), cx);
		}
	}

	/// Advances every region to this frame and requests the next frame while
	/// one moves.
	pub fn step(&mut self, window: &mut Window, cx: &App) -> Openness {
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.sidebar);
		frame.track(&mut self.panel);
		frame.track(&mut self.drawer);
		self.driver.end(frame, window);
		Openness {
			sidebar: self.sidebar.value().clamp(0.0, 1.0),
			panel:   self.panel.value().clamp(0.0, 1.0),
			drawer:  self.drawer.value().clamp(0.0, 1.0),
		}
	}
}

const fn unit(open: bool) -> f32 {
	if open { 1.0 } else { 0.0 }
}

fn drive(value: &mut Animator<FrameInstant>, target: f32, cx: &App) {
	let policy = cx.motion_policy();
	if policy.reduced() {
		value.snap(target);
	} else {
		value.retarget(target, motion::REGION, policy, cx.frame_instant());
	}
}
