//! Measured, interruptible disclosure.
//!
//! The caller reports the destination body height after layout. Toggle events
//! retarget that height spring and the chevron at the event instant; rendering
//! only samples. The inner body stays mounted and clipped during reversal.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, icon, square, text};
use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, radius, row, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Disclosure {
	id:              SharedString,
	owner:           RetainedKey,
	what:            SharedString,
	count:           Option<SharedString>,
	icon:            Option<Icon>,
	open:            bool,
	measured_height: f32,
	body:            Vec<AnyElement>,
	quiet:           bool,
	on_toggle:       Option<Click>,
}

impl Disclosure {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		what: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			what: what.into(),
			count: None,
			icon: None,
			open: false,
			measured_height: 0.0,
			body: Vec::new(),
			quiet: false,
			on_toggle: None,
		}
	}

	pub fn open(mut self, open: bool) -> Self {
		self.open = open;
		self
	}

	pub fn measured_height(mut self, height: f32) -> Self {
		self.measured_height = height.max(0.0);
		self
	}

	pub fn count(mut self, count: impl Into<SharedString>) -> Self {
		self.count = Some(count.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn quiet(mut self) -> Self {
		self.quiet = true;
		self
	}

	pub fn on_toggle(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_toggle = Some(Box::new(listener));
		self
	}
}

impl ParentElement for Disclosure {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.body.extend(elements);
	}
}

impl RenderOnce for Disclosure {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let height_key = MotionKey::new(self.owner, Property::Height);
		let rotation_key = MotionKey::new(self.owner, Property::Rotation);
		let hover_key = MotionKey::new(self.owner, Property::ColorMix);
		let target_height = if self.open { self.measured_height } else { 0.0 };
		let height = paint::sample(cx, height_key, target_height);
		let rotation = paint::sample(cx, rotation_key, f32::from(u8::from(self.open)));
		let hover = paint::sample(cx, hover_key, 0.0);
		let ground = mix(gpui::transparent_black(), theme.hover(), hover);
		let pressable = self.on_toggle.is_some();
		let ink = if self.quiet {
			theme.text_faint
		} else {
			theme.text_muted
		};
		let mut header = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.items_center()
			.gap(px(space::SNUG))
			.w_full()
			.h(px(if self.quiet {
				row::compact()
			} else {
				row::normal()
			}))
			.px(px(space::SNUG))
			.rounded(px(radius::ROW));
		if pressable {
			header = header
				.bg(ground)
				.cursor_pointer()
				.on_hover(move |over, _window, cx| {
					let program = if *over {
						spec::HOVER_IN
					} else {
						spec::HOVER_OUT
					};
					let _ = paint::retarget(
						cx,
						hover_key,
						program,
						u8::from(*over) as f32,
						Priority::Content,
						Damage::Paint(0),
					);
					cx.refresh_windows();
				});
		}
		header = header.child(square(icon::scale::small()).children(
			pressable.then(|| icon::turning(Icon::Folded, icon::scale::small(), ink, rotation * 0.25)),
		));
		let header = header
			.children(self.icon.map(|glyph| {
				square(icon::scale::small()).child(icon::at(glyph, icon::scale::small(), ink))
			}))
			.child(
				text::line(self.what)
					.flex_1()
					.min_w(px(0.0))
					.text_size(px(if self.quiet {
						size::overline()
					} else {
						size::body()
					}))
					.font_weight(weight::MEDIUM)
					.text_color(if self.quiet {
						theme.text_faint
					} else {
						theme.text
					}),
			)
			.children(self.count.map(|count| text::meta(count, &theme)));
		let measured = self.measured_height;
		let next_open = !self.open;
		let header = match self.on_toggle {
			Some(listener) => header.on_click(move |event, window, cx| {
				let target = if next_open { measured } else { 0.0 };
				let _ = paint::retarget(
					cx,
					height_key,
					spec::LAYOUT,
					target,
					Priority::Content,
					Damage::Layout(0),
				);
				let _ = paint::retarget(
					cx,
					rotation_key,
					spec::DISCLOSURE_ROTATE,
					u8::from(next_open) as f32,
					Priority::Content,
					Damage::Paint(0),
				);
				listener(event, window, cx);
			}),
			None => header,
		};
		text::stack(space::ROWS).w_full().child(header).child(
			div()
				.w_full()
				.h(px(height.max(0.0)))
				.overflow_hidden()
				.child(text::stack(space::ROWS).w_full().children(self.body)),
		)
	}
}
