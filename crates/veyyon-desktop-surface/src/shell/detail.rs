//! The anchored detail popover the window holds between frames (§5.6, §8.25).
//!
//! The popover is one surface opened from three: a workspace tree row, the
//! composer's model chip and a diff hunk header. Which one opened it decides
//! the float track it animates on, so two sources never share an animation
//! slot, and the facts it states are derived from the state the same frame
//! draws from.
//!
//! While it is open it holds the window's focus. That is the containment this
//! framework offers: the keystrokes the surface under it would answer do not
//! reach that surface, and closing gives the focus back to whatever held it.
//! It is not a tab cage -- nothing in this window navigates by tab stop -- and
//! a chord bound above the popover on the focus path, `Escape` among them,
//! still resolves at the shell, which is where every float is dismissed.

use std::time::Instant;

use veyyon_desktop_motion::SurfaceId;
use veyyon_gpui::{AnyElement, Context, FocusHandle, IntoElement, Size, Window, px};

use super::ShellView;
use crate::{
	detail::{Detail, DetailSource, detail_facts},
	palette::motion::FloatMotion,
};

/// The surface whose float track a detail popover animates on.
const fn detail_owner(source: DetailSource) -> SurfaceId {
	match source {
		DetailSource::TreeRow | DetailSource::DiffHunk => SurfaceId::RightPanel,
		DetailSource::Model => SurfaceId::Composer,
	}
}

impl ShellView {
	/// The detail popover that is open, if one is.
	#[must_use]
	pub const fn detail(&self) -> Option<&Detail> {
		self.detail.as_ref()
	}

	/// Opens a detail popover, taking the window's focus and recording where
	/// to give it back.
	pub fn open_detail(&mut self, detail: Detail, window: &mut Window, cx: &mut Context<Self>) {
		self.detail_motion = FloatMotion::new(detail_owner(detail.kind.source()), 0);
		// The focus is recorded before it is taken, and only when the popover
		// was not already holding it: reopening from inside the popover would
		// otherwise record the popover as the place to return to and leave the
		// window with no focused surface when it closes.
		let held = self.detail_focus.as_ref();
		let focused = window.focused(cx);
		if focused.as_ref() != held {
			self.detail_return = focused;
		}
		let focus = self
			.detail_focus
			.get_or_insert_with(|| cx.focus_handle())
			.clone();
		self.detail = Some(detail);
		window.focus(&focus, cx);
	}

	/// Closes the detail popover and returns the focus, if one is open.
	pub fn close_detail(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.detail.take().is_none() {
			return;
		}
		if let Some(focus) = self.detail_return.take() {
			window.focus(&focus, cx);
		}
	}

	/// Opens the detail for `detail`, or closes the one already open on the
	/// same thing, which is what a second press on the control that opened it
	/// means.
	pub fn toggle_detail(&mut self, detail: Detail, window: &mut Window, cx: &mut Context<Self>) {
		if self
			.detail
			.as_ref()
			.is_some_and(|open| open.kind == detail.kind)
		{
			self.close_detail(window, cx);
		} else {
			self.open_detail(detail, window, cx);
		}
	}
}

/// Draws the detail popover, or nothing when none is open and the last one has
/// finished fading.
pub(super) fn detail_float(
	view: &mut ShellView,
	window: &Window,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	let open = view.detail.is_some();
	if open && view.detail_retained.as_ref() != view.detail.as_ref() {
		view.detail_retained.clone_from(&view.detail);
	}
	view.detail_retained.as_ref()?;
	let frame = view.detail_motion.sample(
		open,
		Instant::now(),
		&view.installed.motion,
		view.rail_motion.is_reduced_motion(),
	);
	if !open && frame.settled {
		view.detail_retained = None;
		return None;
	}
	if !frame.settled {
		let entity = cx.entity();
		window.on_next_frame(move |_window, app| entity.update(app, |_view, cx| cx.notify()));
	}
	let detail = view.detail_retained.clone()?;
	// A payload the state no longer holds states nothing, so the popover goes
	// rather than drawing a card with a heading and no facts under it.
	let facts = detail_facts(&detail.kind, &view.state)?;
	let focus: FocusHandle = view
		.detail_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	let palette = &view.installed.surface.palette;
	let size = Size { width: px(palette.anchored_width_px), height: px(palette.max_height_px) };
	Some(
		crate::detail::detail_layer(&detail, &facts, frame, &focus, size, &view.installed.set, cx)
			.into_any_element(),
	)
}
