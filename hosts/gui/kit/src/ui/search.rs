//! A filter over what a surface is showing.
//!
//! Every list in the window is filtered the same way: a glyph, a field, and
//! sometimes a count of what survived. Before this existed each surface built
//! that row itself, and four of them had four gaps, three paddings, two text
//! sizes and one ground between them; none of the four told a pointer it was a
//! field, because a hand-built row has no hover state to give.
//!
//! WHAT A SURFACE STILL OWNS. The editor. A field is a session-scoped entity
//! with a caret, a selection and its own key bindings, so it is built once
//! where the handles live and handed here per frame. This draws the box around
//! it.

use gpui::{
	AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px, transparent_black,
};

use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, layout, radius, size, space},
	ui::{Icon, icon, text},
};

/// How much of a box the row draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchGround {
	/// A sunken box: the field is a control on a panel of other things.
	#[default]
	Sunken,
	/// No box at all: the surface around it is already the field's card, and a
	/// second ground inside it reads as a control inside a control. What the
	/// command palette needs, whose whole sheet is the field.
	Bare,
}

/// A filter row: a glyph, a field, and what it found.
#[derive(IntoElement)]
pub struct SearchField {
	id:        SharedString,
	owner:     RetainedKey,
	field:     AnyElement,
	ground:    SearchGround,
	/// Lead type for a field that is the whole point of the surface it sits in.
	prominent: bool,
	focused:   bool,
	hint:      Option<SharedString>,
}

impl SearchField {
	/// `field` is the editor the surface owns, rendered for this frame.
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		field: impl IntoElement,
	) -> SearchField {
		SearchField {
			id: id.into(),
			owner,
			field: field.into_any_element(),
			ground: SearchGround::default(),
			prominent: false,
			focused: false,
			hint: None,
		}
	}

	pub fn ground(mut self, ground: SearchGround) -> SearchField {
		self.ground = ground;
		self
	}

	/// Lead type and no box, for a field that is the surface.
	pub fn prominent(mut self) -> SearchField {
		self.prominent = true;
		self.ground = SearchGround::Bare;
		self
	}

	/// Draw the ring. The editor holds the keyboard, so the row cannot read
	/// focus for itself.
	pub fn focused(mut self, focused: bool) -> SearchField {
		self.focused = focused;
		self
	}

	/// What the filter found, at the far end: a count, or a chord.
	pub fn hint(mut self, hint: impl Into<SharedString>) -> SearchField {
		self.hint = Some(hint.into());
		self
	}
}

impl RenderOnce for SearchField {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::ColorMix);
		let boxed = matches!(self.ground, SearchGround::Sunken);
		// A bare row has nothing to lighten, so it asks the registry for
		// nothing: a channel sampled every frame for a mix that is never drawn
		// keeps the window awake for no picture.
		let hover = if boxed {
			paint::sample(cx, key, 0.0)
		} else {
			0.0
		};
		let rest = if boxed {
			theme.sunken
		} else {
			transparent_black()
		};
		let glyph_size = if self.prominent {
			icon::scale::base()
		} else {
			icon::scale::small()
		};
		let mut row = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.items_center()
			.w_full()
			.gap(px(space::X8))
			.h(px(layout::control_height()))
			.px(px(space::X8))
			.rounded(px(radius::CONTROL))
			.bg(mix(rest, theme.hover(), hover))
			.child(icon::at(Icon::Search, glyph_size, theme.text_faint))
			.child(
				div()
					.flex_1()
					.min_w(px(0.0))
					.overflow_hidden()
					.text_size(px(if self.prominent {
						size::lead()
					} else {
						size::body()
					}))
					.child(self.field),
			)
			.children(
				self
					.hint
					.map(|hint| div().flex_none().child(text::meta(hint, &theme))),
			);
		if self.focused {
			row = row.shadow(theme.focus_ring());
		}
		if boxed {
			row = row.on_hover(move |over, _window, cx| {
				let program = if *over {
					spec::HOVER_IN
				} else {
					spec::HOVER_OUT
				};
				let _ = paint::retarget(
					cx,
					key,
					program,
					u8::from(*over) as f32,
					Priority::Content,
					Damage::Paint(0),
				);
				cx.refresh_windows();
			});
		}
		row.cursor_text()
	}
}
