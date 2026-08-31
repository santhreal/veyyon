//! Interruptible on/off control.
//!
//! Toggle events retarget one retained layout spring. Rapid reversals preserve
//! knob position and velocity. A disabled switch requires a reason.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, lerp, mix, spec},
	paint,
	theme::{Theme, control},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Switch {
	id:              SharedString,
	owner:           RetainedKey,
	on:              bool,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}

impl Switch {
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, on: bool) -> Self {
		Self { id: id.into(), owner, on, disabled_reason: None, on_click: None }
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

impl RenderOnce for Switch {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::TranslateX);
		let endpoint = u8::from(self.on) as f32;
		let travel = paint::sample(cx, key, endpoint);
		let track = mix(theme.sunken, theme.accent, travel);
		let knob = mix(theme.text_muted, theme.text_on_accent, travel);
		let inset = control::SWITCH_INSET;
		let slide = lerp(inset, control::switch_width() - control::switch_knob() - inset, travel);
		let element = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.relative()
			.w(px(control::switch_width()))
			.h(px(control::switch_height()))
			.rounded_full()
			.bg(track)
			.border_1()
			.border_color(if self.on {
				gpui::transparent_black()
			} else {
				theme.stroke
			})
			.child(
				div()
					.absolute()
					.top(px((control::switch_height() - control::switch_knob()) / 2.0))
					.left(px(slide))
					.size(px(control::switch_knob()))
					.rounded_full()
					.bg(knob)
					.shadow(theme.shadow_card()),
			);
		let disabled = self.disabled_reason.is_some();
		let element = match self.disabled_reason {
			Some(reason) => element.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => element,
		};
		let Some(listener) = self.on_click.filter(|_| !disabled) else {
			return element.cursor_default();
		};
		let target = u8::from(!self.on) as f32;
		element.cursor_pointer().on_click(move |event, window, cx| {
			let _ =
				paint::retarget(cx, key, spec::SELECT, target, Priority::Focused, Damage::Paint(0));
			listener(event, window, cx);
		})
	}
}
