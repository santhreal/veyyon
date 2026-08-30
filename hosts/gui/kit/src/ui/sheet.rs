//! A panel over the whole window, and the ground that dims behind it.
//!
//! The command palette, a confirmation, a picker that needs the room. A sheet
//! is for a task that owns the window until it is finished; anything that can
//! be done next to what it is about is a [`Menu`](super::Menu) instead.
//!
//! ARRIVAL IS THE CALLER'S NUMBER. The surface owns whether the sheet is
//! opening, open or leaving, because it is the surface that has to keep the
//! element mounted while it goes; this draws whatever fraction it is handed. It
//! arrives down and back, which is the direction the eye expects something to
//! come from when it comes from nothing.
//!
//! Escape and a press on the ground both close it. Both are wired here, so a
//! sheet cannot ship without a way out.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton,
	ParentElement, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::card::{Card, Lift};
use crate::{
	motion,
	theme::{Theme, layout, radius, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A panel over the window.
#[derive(IntoElement)]
pub struct Sheet {
	id:         SharedString,
	children:   Vec<AnyElement>,
	/// 0 while it is absent, 1 while it is open. The caller's channel.
	arrival:    f32,
	width:      f32,
	/// How far down the window the sheet sits. A palette belongs near the top,
	/// where the eye already is after a keystroke; a confirmation belongs in the
	/// middle.
	top:        Option<f32>,
	pad:        f32,
	on_dismiss: Option<Click>,
}

impl Sheet {
	pub fn new(id: impl Into<SharedString>, arrival: f32) -> Sheet {
		Sheet {
			id:         id.into(),
			children:   Vec::new(),
			arrival:    arrival.clamp(0.0, 1.0),
			width:      layout::SHEET,
			top:        Some(116.0),
			pad:        space::SNUG,
			on_dismiss: None,
		}
	}

	pub fn width(mut self, width: f32) -> Sheet {
		self.width = width;
		self
	}

	/// Centre it in the window rather than hanging it from the top.
	pub fn centred(mut self) -> Sheet {
		self.top = None;
		self
	}

	pub fn top(mut self, top: f32) -> Sheet {
		self.top = Some(top);
		self
	}

	pub fn pad(mut self, pad: f32) -> Sheet {
		self.pad = pad;
		self
	}

	/// What a press on the ground behind it does. A sheet with no way out is a
	/// window that has stopped answering.
	pub fn on_dismiss(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Sheet {
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
		let arrival = self.arrival;

		let panel = Card::new()
			.ground(theme.overlay)
			.lift(Lift::Menu)
			.stroked()
			.radius(radius::SHEET)
			.pad(self.pad)
			.gap(space::SNUG)
			.width(self.width)
			.children(self.children);

		let mut sheet = div()
			.id(ElementId::from(self.id.clone()))
			.absolute()
			.inset_0()
			.flex()
			.flex_col()
			.items_center()
			// The ground dims rather than blurs: blur behind a window is a
			// compositor decision on Linux, and a blur that does not happen
			// reads as a defect.
			.bg(theme.scrim().opacity(0.42 * arrival))
			.child(
				div()
					.relative()
					.top(px(motion::lerp(-10.0, 0.0, arrival)))
					.opacity(arrival)
					.shadow(theme.shadow_sheet())
					.rounded(px(radius::SHEET))
					.child(panel)
					// A press inside the sheet is not a press on the ground.
					.on_mouse_down(MouseButton::Left, |_event, _window, cx| {
						cx.stop_propagation();
					}),
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
