//! Retained direct-drag and release motion for shell splits.

use veyyon_desktop_motion::PanelMotion;
use veyyon_gpui::{
	App,
	motion::{FrameInstant, MotionFrame, MotionPolicy, MotionTokens},
};

use super::ShellView;

#[derive(Default)]
pub(super) struct SplitMotions {
	panel:         Option<PanelMotion>,
	drawer:        Option<PanelMotion>,
	queue:         Option<PanelMotion>,
	drawer_target: Option<f32>,
}

impl SplitMotions {
	pub(super) fn drawer_height(&self) -> Option<f32> {
		self.drawer.as_ref().map(PanelMotion::current_width)
	}

	fn release(
		motion: &mut Option<PanelMotion>,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		if let Some(motion) = motion.as_mut().filter(|motion| motion.is_dragging()) {
			motion.release_to_snap(motion.current_width().round(), tokens, policy, now);
		}
	}
}

impl ShellView {
	/// Tracks the panel, drawer and queue widths on `frame` and carries the
	/// sampled widths onto the layout the frame resolves.
	pub(super) fn sample_split_motion(&mut self, frame: &mut MotionFrame) {
		for motion in
			[&mut self.split_motion.panel, &mut self.split_motion.drawer, &mut self.split_motion.queue]
				.into_iter()
				.flatten()
		{
			frame.track(motion);
		}
		if let Some(panel) = &self.split_motion.panel {
			self.panel_width = Some(panel.current_width());
		}
		if let Some(queue) = &self.split_motion.queue {
			self.queue_width = Some(queue.current_width());
		}
	}

	pub(super) fn drag_panel(&mut self, width: f32, min: f32, max: f32, cx: &App) {
		let motion = self
			.split_motion
			.panel
			.get_or_insert_with(|| PanelMotion::with_bounds(width, min, max));
		motion.set_bounds(min, max);
		motion.set_direct(width, cx.frame_instant());
		self.panel_width = Some(motion.current_width());
	}

	pub(super) fn release_panel(&mut self, cx: &App) {
		SplitMotions::release(
			&mut self.split_motion.panel,
			&self.installed.motion,
			cx.motion_policy(),
			cx.frame_instant(),
		);
	}

	pub(crate) fn drag_queue(&mut self, width: f32, min: f32, max: f32, cx: &App) {
		let motion = self
			.split_motion
			.queue
			.get_or_insert_with(|| PanelMotion::with_bounds(width, min, max));
		motion.set_bounds(min, max);
		motion.set_direct(width, cx.frame_instant());
		self.queue_width = Some(motion.current_width());
	}

	pub(crate) fn release_queue(&mut self, cx: &App) {
		SplitMotions::release(
			&mut self.split_motion.queue,
			&self.installed.motion,
			cx.motion_policy(),
			cx.frame_instant(),
		);
	}

	pub(super) fn drag_drawer(&mut self, height: f32, min: f32, max: f32, cx: &App) {
		self.split_motion.drawer_target = Some(height);
		let motion = self
			.split_motion
			.drawer
			.get_or_insert_with(|| PanelMotion::with_bounds(height, min, max));
		motion.set_bounds(min, max);
		motion.set_direct(height, cx.frame_instant());
	}

	/// Seeds the drawer at the height a previous window was left at (§8.10).
	///
	/// The bounds are the seeded height itself: the shed clamps the drawn
	/// height to what this window can hold on the next frame, and a later drag
	/// replaces the bounds with the ones that drag allows.
	pub(super) const fn restore_drawer_height(&mut self, height: f32) {
		self.split_motion.drawer_target = Some(height);
		self.split_motion.drawer = Some(PanelMotion::with_bounds(height, 0.0, height));
	}

	pub(super) fn release_drawer(&mut self, cx: &App) {
		SplitMotions::release(
			&mut self.split_motion.drawer,
			&self.installed.motion,
			cx.motion_policy(),
			cx.frame_instant(),
		);
	}

	/// Drives the drawer height spring when toggled open or closed (§7.1).
	pub(super) fn toggle_drawer(&mut self, open: bool, cx: &App) {
		let (policy, now) = (cx.motion_policy(), cx.frame_instant());
		if open {
			let target_height = if let Some(target) = self.split_motion.drawer_target {
				target
			} else if let Some(width) = self
				.split_motion
				.drawer
				.as_ref()
				.map(PanelMotion::current_width)
				.filter(|&w| w > 0.0)
			{
				width
			} else {
				self.installed.surface.panels.terminal_drawer_min_height_px
			};
			self.split_motion.drawer_target = Some(target_height);
			let motion = self
				.split_motion
				.drawer
				.get_or_insert_with(|| PanelMotion::with_bounds(0.0, 0.0, target_height));
			motion.set_bounds(0.0, target_height);
			motion.release_to_snap(target_height, &self.installed.motion, policy, now);
		} else if let Some(motion) = &mut self.split_motion.drawer {
			if motion.current_width() > 0.0 {
				self.split_motion.drawer_target = Some(motion.current_width());
			}
			let current = motion.current_width();
			let max = motion.bounds().map_or(current, |(_, max)| max).max(current);
			motion.set_bounds(0.0, max);
			motion.release_to_snap(0.0, &self.installed.motion, policy, now);
		}
	}
}
