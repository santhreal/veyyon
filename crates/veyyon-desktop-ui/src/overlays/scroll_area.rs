//! A vertically scrolling region with an overlay scrollbar.

use std::time::Duration;

use veyyon_gpui::{
	AnyElement, App, Context, ElementId, IntoElement, ParentElement, Pixels,
	RenderOnce, ScrollHandle, ScrollWheelEvent, Task, Window, div,
	motion::{Animator, FrameInstant, MotionDriver},
	prelude::*,
	px,
};

use super::drive;
use crate::theme::{ActiveTheme, motion, radius, size, space};

/// How long the scrollbar stays after the last scroll before it fades.
const IDLE: Duration = Duration::from_millis(900);

/// A region that scrolls its children vertically, with a thin `border.strong`
/// thumb drawn over the right edge.
///
/// The thumb fades in when the region scrolls or the pointer enters it and
/// fades out [`IDLE`] after the last scroll once the pointer has left. The
/// delay is one scheduled task per scroll burst; no frame is drawn while the
/// thumb is at rest.
#[derive(IntoElement)]
pub struct ScrollArea {
	id:       ElementId,
	handle:   Option<ScrollHandle>,
	children: Vec<AnyElement>,
}

impl ScrollArea {
	/// An empty scroll area. `id` keys its scroll offset and thumb state
	/// across frames.
	pub fn new(id: impl Into<ElementId>) -> Self {
		Self { id: id.into(), handle: None, children: Vec::new() }
	}

	/// Scrolls through `handle`, so the owner can read and set the offset.
	pub fn track_scroll(mut self, handle: &ScrollHandle) -> Self {
		self.handle = Some(handle.clone());
		self
	}
}

impl ParentElement for ScrollArea {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(elements);
	}
}

/// Thumb state of one scroll area, kept across frames.
struct ScrollState {
	handle:  ScrollHandle,
	thumb:   Animator<FrameInstant>,
	driver:  MotionDriver,
	hovered: bool,
	idle:    Option<Task<()>>,
}

impl ScrollState {
	fn new() -> Self {
		Self {
			handle:  ScrollHandle::new(),
			thumb:   Animator::at_rest(0.0),
			driver:  MotionDriver::default(),
			hovered: false,
			idle:    None,
		}
	}

	/// Shows the thumb and restarts the idle delay.
	fn reveal(&mut self, cx: &mut Context<Self>) {
		drive(&mut self.thumb, 1.0, motion::HOVER, cx);
		self.idle = (!self.hovered).then(|| Self::fade_after_idle(cx));
		cx.notify();
	}

	fn set_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
		self.hovered = hovered;
		if hovered {
			drive(&mut self.thumb, 1.0, motion::HOVER, cx);
			self.idle = None;
		} else {
			self.idle = Some(Self::fade_after_idle(cx));
		}
		cx.notify();
	}

	fn fade_after_idle(cx: &Context<Self>) -> Task<()> {
		cx.spawn(async move |this, cx| {
			cx.background_executor().timer(IDLE).await;
			this.update(cx, |this, cx| {
				this.idle = None;
				drive(&mut this.thumb, 0.0, motion::REVEAL, cx);
				cx.notify();
			})
			.ok();
		})
	}

	/// The thumb's top and length in the viewport, or `None` when the
	/// content fits.
	fn thumb_geometry(&self) -> Option<(Pixels, Pixels)> {
		let viewport = f32::from(self.handle.bounds().size.height);
		let range = f32::from(self.handle.max_offset().y);
		if range <= 0.0 || viewport <= 0.0 {
			return None;
		}
		let visible = viewport / (viewport + range);
		let length = (viewport * visible)
			.max(f32::from(size::SCROLLBAR_THUMB_MIN))
			.min(viewport);
		let scrolled = -f32::from(self.handle.offset().y);
		let progress = (scrolled / range).clamp(0.0, 1.0);
		Some((px((viewport - length) * progress), px(length)))
	}
}

impl RenderOnce for ScrollArea {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let state = window.use_keyed_state(self.id.clone(), cx, |_, _| ScrollState::new());
		let handle = self.handle;
		let (opacity, thumb, handle) = state.update(cx, |state, cx| {
			if let Some(handle) = handle {
				state.handle = handle;
			}
			let mut frame = state.driver.begin(cx);
			frame.track(&mut state.thumb);
			state.driver.end(frame, window);
			(state.thumb.value(), state.thumb_geometry(), state.handle.clone())
		});
		let color = cx.theme().palette.border.strong;
		let hover_state = state.clone();
		div()
			.id(self.id)
			.relative()
			.size_full()
			.on_hover(move |hovered, _, cx| {
				hover_state.update(cx, |state, cx| state.set_hovered(*hovered, cx));
			})
			.child(
				div()
					.id("viewport")
					.size_full()
					.overflow_y_scroll()
					.track_scroll(&handle)
					.on_scroll_wheel(move |_: &ScrollWheelEvent, _, cx| {
						state.update(cx, |state, cx| state.reveal(cx));
					})
					.children(self.children),
			)
			.when_some(thumb.filter(|_| opacity > 0.0), |el, (top, length)| {
				el.child(
					div()
						.absolute()
						.top(top)
						.right(space::S0_5)
						.w(size::SCROLLBAR)
						.h(length)
						.rounded(radius::FULL)
						.bg(color)
						.opacity(opacity),
				)
			})
	}
}
