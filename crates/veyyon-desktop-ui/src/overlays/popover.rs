//! A surface anchored to a point of the window. Menus, selects and pickers
//! open in one.

use veyyon_gpui::{
	Anchor, AnyView, App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable,
	IntoElement, KeyDownEvent, MouseDownEvent, Pixels, Point, Render, Window, anchored, deferred,
	div,
	motion::{Animator, FrameInstant, MotionDriver},
	point,
	prelude::*,
};

use super::drive;
use crate::theme::{ActiveTheme, motion, radius, space};

/// What a popover reports to its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopoverEvent {
	/// The popover started closing, after an outside click, Escape or
	/// [`Popover::close`].
	Dismissed,
}

/// The opacity and scale a popover draws with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Presentation {
	/// Opacity of the surface, 0 to 1.
	pub opacity: f32,
	/// Scale of the surface, [`motion::POPOVER_SCALE`] to 1.
	pub scale:   f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
	Closed,
	Open,
	Closing,
}

/// An anchored surface on `bg.elevated` with a `border.default` outline, a
/// large radius and a soft shadow.
///
/// Opening fades the surface in and scales it from [`motion::POPOVER_SCALE`]
/// to 1 under [`motion::POPOVER_OPEN`]; closing reverses it under
/// [`motion::POPOVER_CLOSE`], and the surface stays mounted until the close
/// motion ends. GPUI has no element scale transform, so the scale is drawn as
/// a drift of [`space::S1`] toward the anchor.
///
/// A click outside the surface and Escape close it. Opening moves focus into
/// the content; closing returns focus to the element that held it before.
/// Render the entity anywhere in the owner's tree: the surface is deferred and
/// positioned in window coordinates.
pub struct Popover {
	content:       AnyView,
	content_focus: FocusHandle,
	phase:         Phase,
	position:      Point<Pixels>,
	anchor:        Anchor,
	trigger:       Option<Bounds<Pixels>>,
	return_focus:  Option<FocusHandle>,
	opacity:       Animator<FrameInstant>,
	scale:         Animator<FrameInstant>,
	driver:        MotionDriver,
}

impl EventEmitter<PopoverEvent> for Popover {}

impl Popover {
	/// A closed popover showing `content`, which receives focus while the
	/// popover is open.
	pub fn new<V: Render + Focusable>(content: &Entity<V>, cx: &App) -> Self {
		Self {
			content:       content.clone().into(),
			content_focus: content.focus_handle(cx),
			phase:         Phase::Closed,
			position:      Point::default(),
			anchor:        Anchor::TopLeft,
			trigger:       None,
			return_focus:  None,
			opacity:       Animator::at_rest(0.0),
			scale:         Animator::at_rest(motion::POPOVER_SCALE),
			driver:        MotionDriver::default(),
		}
	}

	/// Opens the popover with its `anchor` corner at `position`, in window
	/// coordinates. A mouse-down inside `trigger` does not close it, so the
	/// trigger's own click can toggle it.
	pub fn open(
		&mut self,
		position: Point<Pixels>,
		anchor: Anchor,
		trigger: Option<Bounds<Pixels>>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.phase == Phase::Closed {
			self.opacity.snap(0.0);
			self.scale.snap(motion::POPOVER_SCALE);
		}
		if self.phase != Phase::Open {
			self.return_focus = window.focused(cx);
		}
		self.phase = Phase::Open;
		self.position = position;
		self.anchor = anchor;
		self.trigger = trigger;
		drive(&mut self.opacity, 1.0, motion::POPOVER_OPEN, cx);
		drive(&mut self.scale, 1.0, motion::POPOVER_OPEN, cx);
		window.focus(&self.content_focus, cx);
		cx.notify();
	}

	/// Starts closing the popover, returns focus and emits
	/// [`PopoverEvent::Dismissed`]. Does nothing unless it is open.
	pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.phase != Phase::Open {
			return;
		}
		self.phase = Phase::Closing;
		drive(&mut self.opacity, 0.0, motion::POPOVER_CLOSE, cx);
		drive(&mut self.scale, motion::POPOVER_SCALE, motion::POPOVER_CLOSE, cx);
		if let Some(focus) = self.return_focus.take() {
			window.focus(&focus, cx);
		}
		cx.emit(PopoverEvent::Dismissed);
		cx.notify();
	}

	/// Whether the popover is open. A closing popover is not.
	pub const fn is_open(&self) -> bool {
		matches!(self.phase, Phase::Open)
	}

	/// The opacity and scale the next frame draws with.
	pub fn presentation(&self, cx: &App) -> Presentation {
		let now = cx.frame_instant();
		Presentation { opacity: self.opacity.sample(now).value, scale: self.scale.sample(now).value }
	}

	fn on_mouse_down_out(
		&mut self,
		event: &MouseDownEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.trigger.is_some_and(|trigger| trigger.contains(&event.position)) {
			return;
		}
		self.close(window, cx);
	}

	fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
		if event.keystroke.key == "escape" && self.is_open() {
			self.close(window, cx);
			cx.stop_propagation();
		}
	}
}

impl Render for Popover {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.opacity);
		frame.track(&mut self.scale);
		self.driver.end(frame, window);
		if self.phase == Phase::Closing && self.opacity.is_at_rest() {
			self.phase = Phase::Closed;
		}
		if self.phase == Phase::Closed {
			return div().into_any_element();
		}
		let palette = cx.theme().palette;
		let travel = (1.0 - self.scale.value()) / (1.0 - motion::POPOVER_SCALE);
		let surface = div()
			.id("popover")
			.occlude()
			.opacity(self.opacity.value())
			.bg(palette.bg.elevated)
			.rounded(radius::LG)
			.border_1()
			.border_color(palette.border.default)
			.shadow_lg()
			.overflow_hidden()
			.on_mouse_down_out(cx.listener(Self::on_mouse_down_out))
			.on_key_down(cx.listener(Self::on_key_down))
			.child(self.content.clone());
		deferred(
			anchored()
				.position(self.position)
				.anchor(self.anchor)
				.offset(point(space::S0, -(space::S1 * travel)))
				.snap_to_window_with_margin(space::S2)
				.child(surface),
		)
		.with_priority(1)
		.into_any_element()
	}
}
