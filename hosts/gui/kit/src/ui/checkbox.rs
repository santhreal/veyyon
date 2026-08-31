//! A box that is on, off, or partly on.
//!
//! Distinct from [`Switch`](super::Switch), and the difference is not cosmetic:
//! a switch takes effect when it moves, and a checkbox states a member of a set
//! that something else applies. A switch that appears in a list of eight, seven
//! of which have to be picked before a button is pressed, is a switch used as a
//! checkbox, and it reads as eight settings that already took effect.
//!
//! Three states rather than two, because a parent row over selected children
//! has a real third state: a file tree where two of five files are staged is
//! neither staged nor unstaged, and drawing it as unstaged loses the only
//! information the row had. `Mixed` draws a bar, not a tick, and a press from
//! `Mixed` turns everything on.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px, transparent_black,
};

use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, control, radius},
	ui::{Icon, icon},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// What a checkbox is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Check {
	#[default]
	Off,
	On,
	/// Some of what this box stands for, not all of it.
	Mixed,
}

impl Check {
	/// What the box becomes when it is pressed.
	///
	/// From `Mixed` the press turns everything on: a row that is partly on is
	/// pressed to finish the job, not to undo the part that is already done.
	pub const fn pressed(self) -> Self {
		match self {
			Self::Off | Self::Mixed => Self::On,
			Self::On => Self::Off,
		}
	}

	/// Whether the box is filled, which is both `On` and `Mixed`.
	pub const fn filled(self) -> bool {
		matches!(self, Self::On | Self::Mixed)
	}
}

impl From<bool> for Check {
	fn from(on: bool) -> Self {
		if on { Self::On } else { Self::Off }
	}
}

#[derive(IntoElement)]
pub struct Checkbox {
	id:              SharedString,
	owner:           RetainedKey,
	state:           Check,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}

impl Checkbox {
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, state: impl Into<Check>) -> Self {
		Self { id: id.into(), owner, state: state.into(), disabled_reason: None, on_click: None }
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.disabled_reason = Some(reason.into());
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Checkbox {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::Scale);
		// One channel for the fill and the mark together: a tick that grows
		// while the box is still empty reads as two controls.
		let fill = paint::sample(cx, key, if self.state.filled() { 1.0 } else { 0.0 });
		let box_fill = mix(transparent_black(), theme.accent, fill);
		let mark = theme.text_on_accent;
		let mark_size = control::checkbox_mark() * fill;

		let element = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.size(px(control::checkbox()))
			.rounded(px(radius::CONTROL))
			.bg(box_fill)
			.border_1()
			.border_color(if self.state.filled() {
				transparent_black()
			} else {
				theme.stroke
			})
			.child(match self.state {
				Check::Off => div().size(px(0.0)),
				Check::On => div().child(icon::at(Icon::Check, mark_size, mark)),
				Check::Mixed => div()
					.w(px(mark_size))
					.h(px(control::CHECKBOX_BAR))
					.rounded(px(control::CHECKBOX_BAR))
					.bg(mark),
			});

		let disabled = self.disabled_reason.is_some();
		let element = match self.disabled_reason {
			Some(reason) => element.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => element,
		};
		let Some(listener) = self.on_click.filter(|_| !disabled) else {
			return element.cursor_default();
		};
		let target = if self.state.pressed().filled() {
			1.0
		} else {
			0.0
		};
		element.cursor_pointer().on_click(move |event, window, cx| {
			let _ =
				paint::retarget(cx, key, spec::SELECT, target, Priority::Focused, Damage::Paint(0));
			listener(event, window, cx);
		})
	}
}

#[cfg(test)]
mod tests {
	use super::Check;

	#[test]
	fn a_press_walks_off_to_on_and_back() {
		assert_eq!(Check::Off.pressed(), Check::On);
		assert_eq!(Check::On.pressed(), Check::Off);
	}

	#[test]
	fn a_press_on_a_partial_row_finishes_it() {
		// Never back to Off: the press means "all of them", and undoing the
		// part that is already on is the one thing nobody asked for.
		assert_eq!(Check::Mixed.pressed(), Check::On);
	}

	#[test]
	fn a_partial_row_draws_as_filled() {
		assert!(Check::Mixed.filled(), "Mixed drawn empty loses the only state the row had");
		assert!(Check::On.filled());
		assert!(!Check::Off.filled());
	}

	#[test]
	fn a_bool_reads_as_the_two_certain_states() {
		assert_eq!(Check::from(true), Check::On);
		assert_eq!(Check::from(false), Check::Off);
	}
}
