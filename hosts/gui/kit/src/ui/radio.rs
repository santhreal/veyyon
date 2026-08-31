//! One of several, where picking one unpicks the rest.
//!
//! A radio is not a round checkbox. Its contract is the exclusion, so the
//! control cannot enforce it alone: the caller states which member is chosen
//! and every member draws from that one value. There is no group element here,
//! because a group that owned the choice would be a second copy of state the
//! store already holds.
//!
//! What this rules out is the pattern it replaces. Three switches where one is
//! meant to be on has no state that says "none yet", turns off the one that was
//! on before anything else turns on, and shows two on at once for a frame in
//! between.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, control},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Radio {
	id:              SharedString,
	owner:           RetainedKey,
	chosen:          bool,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}

impl Radio {
	/// One member. `chosen` is `selected == this member`, decided by the caller
	/// against the one value that holds the choice.
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, chosen: bool) -> Self {
		Self { id: id.into(), owner, chosen, disabled_reason: None, on_click: None }
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

impl RenderOnce for Radio {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::Scale);
		let grow = paint::sample(cx, key, f32::from(u8::from(self.chosen)));
		let ring = mix(theme.stroke, theme.accent, grow);

		let element = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.size(px(control::radio()))
			.rounded_full()
			.border_1()
			.border_color(ring)
			.child(
				div()
					.size(px(control::radio_dot() * grow))
					.rounded_full()
					.bg(theme.accent),
			);

		let disabled = self.disabled_reason.is_some();
		let element = match self.disabled_reason {
			Some(reason) => element.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => element,
		};
		// A chosen member is not a press target: pressing it again would either
		// do nothing or turn the choice off, and neither is what a member of an
		// exclusive set does.
		let Some(listener) = self.on_click.filter(|_| !disabled && !self.chosen) else {
			return element.cursor_default();
		};
		element.cursor_pointer().on_click(move |event, window, cx| {
			let _ = paint::retarget(cx, key, spec::SELECT, 1.0, Priority::Focused, Damage::Paint(0));
			listener(event, window, cx);
		})
	}
}
