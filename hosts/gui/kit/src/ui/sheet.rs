//! Responsive modal sheet.
//!
//! A sheet fills the viewport, leaves the named sixteen-pixel narrow margin,
//! and caps its content width. Motion identity is retained by the overlay
//! model; rendering samples its shared-element and opacity properties.
//! Dismissal by the scrim is always available when the caller supplies the
//! listener. Use [`FocusScope`](super::FocusScope) for event-time containment
//! and restoration.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton,
	ParentElement, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
	motion::{MotionKey, Property, RetainedKey, lerp},
	paint,
	theme::{Theme, layout, radius, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Sheet {
	id:         SharedString,
	owner:      RetainedKey,
	children:   Vec<AnyElement>,
	open:       bool,
	max_width:  f32,
	top:        Option<f32>,
	pad:        f32,
	on_dismiss: Option<Click>,
}

impl Sheet {
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, open: bool) -> Self {
		Self {
			id: id.into(),
			owner,
			children: Vec::new(),
			open,
			max_width: layout::SHEET,
			top: Some(layout::SHEET_TOP),
			pad: space::SNUG,
			on_dismiss: None,
		}
	}

	pub fn max_width(mut self, width: f32) -> Self {
		self.max_width = width;
		self
	}

	pub fn centred(mut self) -> Self {
		self.top = None;
		self
	}

	pub fn top(mut self, top: f32) -> Self {
		self.top = Some(top);
		self
	}

	pub fn pad(mut self, pad: f32) -> Self {
		self.pad = pad;
		self
	}

	pub fn on_dismiss(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_dismiss = Some(Box::new(listener));
		self
	}
}
impl ParentElement for Sheet {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(elements);
	}
}

impl RenderOnce for Sheet {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let opacity = paint::sample(
			cx,
			MotionKey::new(self.owner, Property::Opacity),
			u8::from(self.open) as f32,
		);
		let geometry = paint::sample(
			cx,
			MotionKey::new(self.owner, Property::TranslateY),
			u8::from(self.open) as f32,
		);
		let scrim = gpui::Hsla { a: theme.scrim().a * opacity, ..theme.scrim() };
		let panel = div()
			.w_full()
			.max_w(px(self.max_width))
			.p(px(self.pad))
			.flex()
			.flex_col()
			.gap(px(space::SNUG))
			.rounded(px(radius::SHEET))
			.bg(theme.overlay)
			.border_1()
			.border_color(theme.stroke)
			.shadow(theme.shadow_sheet())
			.children(self.children)
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| cx.stop_propagation());
		let mut sheet = div()
			.id(ElementId::from(self.id))
			.absolute()
			.inset_0()
			.flex()
			.flex_col()
			.items_center()
			.px(px(layout::OVERLAY_MARGIN))
			.bg(scrim)
			.child(
				div()
					.w_full()
					.max_w(px(self.max_width))
					.relative()
					.top(px(lerp(-space::BASE, 0.0, geometry)))
					.opacity(opacity)
					.child(panel),
			);
		sheet = match self.top {
			Some(top) => sheet.pt(px(top)),
			None => sheet.justify_center(),
		};
		match self.on_dismiss {
			Some(listener) => sheet.on_click(move |event, window, cx| listener(event, window, cx)),
			None => sheet,
		}
	}
}
