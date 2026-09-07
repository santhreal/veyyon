//! Retained direct-drag and release motion for shell splits.

use std::time::Instant;

use veyyon_desktop_motion::{MotionTokens, PanelMotion, SurfaceId};
use veyyon_gpui::{Context, Window};

use super::ShellView;

#[derive(Default)]
pub(super) struct SplitMotions {
	panel:  Option<PanelMotion>,
	drawer: Option<PanelMotion>,
}

impl SplitMotions {
	pub(super) fn drawer_height(&self) -> Option<f32> {
		self.drawer.as_ref().map(PanelMotion::current_width)
	}

	fn release(
		motion: &mut Option<PanelMotion>,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		if let Some(motion) = motion.as_mut().filter(|motion| motion.is_dragging()) {
			motion.release_to_snap(motion.current_width().round(), tokens, reduced, now);
		}
	}
}

impl ShellView {
	pub(super) fn sample_split_motion(&mut self, window: &Window, cx: &Context<Self>) {
		let now = cx.background_executor().now();
		let mut animating = false;
		for motion in [&mut self.split_motion.panel, &mut self.split_motion.drawer]
			.into_iter()
			.flatten()
		{
			let (_, settled) = motion.sample(now);
			animating |= !settled && !motion.is_dragging();
		}
		if animating {
			let view = cx.weak_entity();
			window.on_next_frame(move |_window, app| {
				let _ = view.update(app, |_view, cx| cx.notify());
			});
		}
		if let Some(panel) = &self.split_motion.panel {
			self.panel_width = Some(panel.current_width());
		}
	}

	pub(super) fn drag_panel(&mut self, width: f32, min: f32, max: f32, cx: &Context<Self>) {
		let motion = self.split_motion.panel.get_or_insert_with(|| {
			PanelMotion::with_bounds(SurfaceId::RightPanel, 0, width, min, max)
		});
		motion.set_bounds(min, max);
		motion.set_direct(width, cx.background_executor().now());
		self.panel_width = Some(motion.current_width());
	}

	pub(super) fn release_panel(&mut self, cx: &Context<Self>) {
		SplitMotions::release(
			&mut self.split_motion.panel,
			&self.installed.motion,
			self.rail_motion.is_reduced_motion(),
			cx.background_executor().now(),
		);
	}

	pub(super) fn drag_drawer(&mut self, height: f32, min: f32, max: f32, cx: &Context<Self>) {
		let motion = self.split_motion.drawer.get_or_insert_with(|| {
			PanelMotion::with_bounds(SurfaceId::TerminalDrawer, 0, height, min, max)
		});
		motion.set_bounds(min, max);
		motion.set_direct(height, cx.background_executor().now());
	}

	/// Seeds the drawer at the height a previous window was left at (§8.10).
	///
	/// The bounds are the seeded height itself: the shed clamps the drawn
	/// height to what this window can hold on the next frame, and a later drag
	/// replaces the bounds with the ones that drag allows.
	pub(super) fn restore_drawer_height(&mut self, height: f32) {
		self.split_motion.drawer =
			Some(PanelMotion::with_bounds(SurfaceId::TerminalDrawer, 0, height, 0.0, height));
	}

	pub(super) fn release_drawer(&mut self, cx: &Context<Self>) {
		SplitMotions::release(
			&mut self.split_motion.drawer,
			&self.installed.motion,
			self.rail_motion.is_reduced_motion(),
			cx.background_executor().now(),
		);
	}
}
