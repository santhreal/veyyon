//! Popover, dialog, and toast containers.
//!
//! Position, lifetime, and product actions remain caller values. These
//! primitives define only elevation, readable measure, clipping, and semantic
//! status treatment. Toast expiration is a product deadline, never an animation
//! timer owned here.

use gpui::{
	AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{
	Icon, Tone,
	card::{Card, Lift},
	icon, text,
};
use crate::theme::{Theme, layout, radius, space, weight};

#[derive(IntoElement)]
pub struct Popover {
	children: Vec<AnyElement>,
	width:    f32,
}
impl Popover {
	pub fn new() -> Self {
		Self { children: Vec::new(), width: layout::measure() }
	}

	pub fn width(mut self, width: f32) -> Self {
		self.width = width;
		self
	}
}
impl Default for Popover {
	fn default() -> Self {
		Self::new()
	}
}
impl ParentElement for Popover {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(items);
	}
}
impl RenderOnce for Popover {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		Card::new()
			.lift(Lift::Menu)
			.stroked()
			.radius(radius::POPOVER)
			.width(self.width)
			.children(self.children)
	}
}

#[derive(IntoElement)]
pub struct Dialog {
	title:   SharedString,
	detail:  Option<SharedString>,
	body:    Vec<AnyElement>,
	actions: Vec<AnyElement>,
	tone:    Tone,
}
impl Dialog {
	pub fn new(title: impl Into<SharedString>) -> Self {
		Self {
			title:   title.into(),
			detail:  None,
			body:    Vec::new(),
			actions: Vec::new(),
			tone:    Tone::Plain,
		}
	}

	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn action(mut self, action: impl IntoElement) -> Self {
		self.actions.push(action.into_any_element());
		self
	}
}
impl ParentElement for Dialog {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.body.extend(items);
	}
}
impl RenderOnce for Dialog {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		Card::new()
			.lift(Lift::Menu)
			.stroked()
			.radius(radius::SHEET)
			.width(layout::measure())
			.child(
				text::line(self.title)
					.font_weight(weight::STRONG)
					.text_color(self.tone.ink(&theme)),
			)
			.children(self.detail.map(|detail| text::note(detail, &theme)))
			.children(self.body)
			.child(
				div()
					.flex()
					.items_center()
					.justify_end()
					.gap(px(space::X6))
					.pt(px(space::X4))
					.children(self.actions),
			)
	}
}

#[derive(IntoElement)]
pub struct Toast {
	title:   SharedString,
	detail:  Option<SharedString>,
	tone:    Tone,
	icon:    Option<Icon>,
	actions: Vec<AnyElement>,
}
impl Toast {
	pub fn new(title: impl Into<SharedString>) -> Self {
		Self {
			title:   title.into(),
			detail:  None,
			tone:    Tone::Plain,
			icon:    None,
			actions: Vec::new(),
		}
	}

	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn action(mut self, action: impl IntoElement) -> Self {
		self.actions.push(action.into_any_element());
		self
	}
}
impl RenderOnce for Toast {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let ink = self.tone.ink(&theme);
		Card::new()
			.lift(Lift::Menu)
			.stroked()
			.radius(radius::POPOVER)
			.width(layout::measure())
			.child(
				div()
					.flex()
					.items_start()
					.gap(px(space::X8))
					.children(
						self
							.icon
							.map(|glyph| icon::at(glyph, icon::scale::base(), ink)),
					)
					.child(
						text::stack(space::X2)
							.flex_1()
							.min_w(px(0.0))
							.child(text::line(self.title).font_weight(weight::MEDIUM))
							.children(self.detail.map(|detail| text::note(detail, &theme))),
					)
					.children(self.actions),
			)
	}
}
