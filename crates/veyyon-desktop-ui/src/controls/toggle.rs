//! An on/off switch.

use veyyon_gpui::{
	App, CursorStyle, ElementId, IntoElement, RenderOnce, Window, div,
	motion::{Animator, FrameInstant, MotionDriver},
	prelude::*,
};

use super::hover_transition;
use crate::theme::{ActiveTheme, motion, size};

type ChangeHandler = Box<dyn Fn(bool, &mut Window, &mut App) + 'static>;

/// A switch: a [`size::TOGGLE_WIDTH`] × [`size::TOGGLE_HEIGHT`] track with a
/// knob that springs between its ends under [`motion::LAYOUT`].
///
/// The track fills with the accent color while on. Clicking an enabled toggle
/// calls its change handler with the opposite of its current state; the
/// caller stores the new state and draws the toggle with it.
#[derive(IntoElement)]
pub struct Toggle {
	id:        ElementId,
	on:        bool,
	disabled:  bool,
	on_change: Option<ChangeHandler>,
}

/// The knob's position between the off end (0) and the on end (1), kept
/// across renders of one toggle.
struct Knob {
	driver:   MotionDriver,
	position: Animator<FrameInstant>,
}

impl Toggle {
	/// A toggle drawn `on` or off. `id` keys the knob's motion, so it is unique
	/// among its siblings.
	pub fn new(id: impl Into<ElementId>, on: bool) -> Self {
		Self { id: id.into(), on, disabled: false, on_change: None }
	}

	/// Disables the toggle.
	pub const fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Calls `handler` with the requested state when an enabled toggle is
	/// clicked.
	pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
		self.on_change = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for Toggle {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let palette = cx.theme().palette;
		let target = if self.on { 1.0 } else { 0.0 };
		let knob = window.use_keyed_state(self.id.clone(), cx, |_, _| Knob {
			driver:   MotionDriver::default(),
			position: Animator::at_rest(target),
		});
		let position = knob.update(cx, |knob, cx| {
			let mut frame = knob.driver.begin(cx);
			if frame.policy().reduced() {
				knob.position.snap(target);
			} else {
				knob
					.position
					.retarget(target, motion::LAYOUT, frame.policy(), frame.now());
			}
			frame.track(&mut knob.position);
			knob.driver.end(frame, window);
			knob.position.value()
		});

		let inset = (size::TOGGLE_HEIGHT - size::TOGGLE_KNOB) / 2.0;
		let travel = size::TOGGLE_WIDTH - size::TOGGLE_HEIGHT;
		let (track, knob_color) = if self.disabled {
			(palette.bg.selected, palette.text.faint)
		} else if self.on {
			(palette.accent.base, palette.accent.fg)
		} else {
			(palette.border.strong, palette.text.primary)
		};
		let on = self.on;
		div()
			.id(self.id)
			.relative()
			.flex_none()
			.w(size::TOGGLE_WIDTH)
			.h(size::TOGGLE_HEIGHT)
			.rounded_full()
			.bg(track)
			.transition(hover_transition())
			.cursor(if self.disabled {
				CursorStyle::OperationNotAllowed
			} else {
				CursorStyle::PointingHand
			})
			.when_some(self.on_change.filter(|_| !self.disabled), |toggle, handler| {
				toggle.on_click(move |_, window, cx| handler(!on, window, cx))
			})
			.child(
				div()
					.absolute()
					.top(inset)
					.left(inset + travel * position)
					.size(size::TOGGLE_KNOB)
					.rounded_full()
					.bg(knob_color),
			)
	}
}
