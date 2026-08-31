//! A group that folds.
//!
//! A project in the sidebar, a settings section, a tool call's output, a diff's
//! hunks. One header that says what is inside and how much of it, and a body
//! that is drawn only while it is open.
//!
//! WHAT IS ANIMATED, AND WHAT IS NOT. The chevron turns and the body fades in,
//! both on the group's own channel. The height does not animate: an unfolding
//! group's height is its content's height, which nothing knows until it has
//! been laid out, and a height animated from a guess overshoots and snaps. A
//! fold is therefore instant in layout and gradual in ink, which reads as fast
//! rather than as broken.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, icon, square, text};
use crate::{
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, radius, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A header, and what it hides.
#[derive(IntoElement)]
pub struct Disclosure {
	id:        SharedString,
	what:      SharedString,
	/// How much is inside, drawn at the end of the header: a count, a size.
	count:     Option<SharedString>,
	icon:      Option<Icon>,
	open:      bool,
	body:      Vec<AnyElement>,
	/// A header set in the smallest type, for a group of rows rather than a
	/// section of a page.
	quiet:     bool,
	on_toggle: Option<Click>,
}

impl Disclosure {
	pub fn new(id: impl Into<SharedString>, what: impl Into<SharedString>) -> Disclosure {
		Disclosure {
			id:        id.into(),
			what:      what.into(),
			count:     None,
			icon:      None,
			open:      false,
			body:      Vec::new(),
			quiet:     false,
			on_toggle: None,
		}
	}

	pub fn open(mut self, open: bool) -> Disclosure {
		self.open = open;
		self
	}

	pub fn count(mut self, count: impl Into<SharedString>) -> Disclosure {
		self.count = Some(count.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Disclosure {
		self.icon = Some(icon);
		self
	}

	/// A group of rows: the header is an overline rather than a heading.
	pub fn quiet(mut self) -> Disclosure {
		self.quiet = true;
		self
	}

	pub fn on_toggle(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Disclosure {
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
		let fold = Key::named(Channel::Group, self.id.as_ref());
		let wash = Key::named(Channel::Control, self.id.as_ref());

		// The chevron points right when folded and down when open, and the
		// quarter turn between the two is the whole of the animation. It is drawn
		// only where pressing does something: a chevron on a header that cannot
		// be folded says there is more behind it, and pressing proves otherwise.
		let open = paint::toward(cx, fold, motion::COLLAPSE, f32::from(u8::from(self.open)));
		let ground = paint::wash(cx, wash, gpui::transparent_black(), theme.hover());
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
			.h(px(if self.quiet { 26.0 } else { 32.0 }))
			.px(px(space::SNUG))
			.rounded(px(radius::CHIP));

		if pressable {
			header = header
				.bg(ground)
				.cursor_pointer()
				.on_hover(move |over, _window, cx| {
					paint::hover(cx, wash, *over);
					cx.refresh_windows();
				});
		}

		// The chevron's track is there either way, so a column of headers whose
		// bodies some have and some do not still reads as one column.
		header = header.child(square(icon::scale::SMALL).children(
			pressable.then(|| icon::turning(Icon::Folded, icon::scale::SMALL, ink, open * 0.25)),
		));

		let header = header
			.children(self.icon.map(|glyph| {
				square(icon::scale::SMALL).child(icon::at(glyph, icon::scale::SMALL, ink))
			}))
			.child(
				text::line(self.what)
					.flex_1()
					.min_w(px(0.0))
					.text_size(px(if self.quiet { size::META } else { size::BODY }))
					.font_weight(weight::MEDIUM)
					.text_color(if self.quiet {
						theme.text_faint
					} else {
						theme.text
					}),
			)
			.children(self.count.map(|count| text::meta(count, &theme)));

		let header = match self.on_toggle {
			Some(listener) => header.on_click(move |event, window, cx| {
				listener(event, window, cx);
			}),
			None => header,
		};

		let mut group = text::stack(space::ROWS).w_full().child(header);
		if self.open {
			group = group.child(
				text::stack(space::ROWS)
					.w_full()
					.opacity(open)
					.children(self.body),
			);
		}
		group
	}
}
