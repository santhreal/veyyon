//! A line in a list.
//!
//! A session in the sidebar, a command in the palette, a file in a
//! changed-files tree, a model in a picker. All of them are this: a glyph, a
//! title, an optional second line, something at the far end, and three states a
//! pointer and a keyboard can put it in.
//!
//! SELECTED AND ACTIVE ARE TWO THINGS. Selected is what the keyboard is on;
//! active is what the window is showing. A palette row is selected while being
//! walked and never active; a sidebar row is both when the conversation it
//! names is open. A list that draws them the same way cannot be walked with the
//! keyboard while it shows what is open.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Tone, icon, square, text};
use crate::{
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, layout, radius, size, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One line in a list.
#[derive(IntoElement)]
pub struct Row {
	id:       SharedString,
	icon:     Option<Icon>,
	/// Keep the icon's space where there is no icon, so a list lines up.
	gutter:   bool,
	title:    SharedString,
	note:     Option<SharedString>,
	trailing: Vec<AnyElement>,
	/// Controls that appear with the pointer and fade with it.
	hovered:  Vec<AnyElement>,
	tone:     Tone,
	/// What the keyboard is on.
	selected: bool,
	/// What the window is showing.
	active:   bool,
	/// Indent, in steps of one level, for a row inside a tree.
	depth:    u8,
	/// Animate the first appearance.
	arrives:  bool,
	on_click: Option<Click>,
}

impl Row {
	pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Row {
		Row {
			id:       id.into(),
			icon:     None,
			gutter:   false,
			title:    title.into(),
			note:     None,
			trailing: Vec::new(),
			hovered:  Vec::new(),
			tone:     Tone::Plain,
			selected: false,
			active:   false,
			depth:    0,
			arrives:  false,
			on_click: None,
		}
	}

	pub fn icon(mut self, icon: Icon) -> Row {
		self.icon = Some(icon);
		self
	}

	/// Keep the space a drawing takes even where there is none.
	///
	/// For a list where only some rows carry one: without it the titles start at
	/// two different offsets, which reads as two lists that happen to be next
	/// to each other.
	pub fn gutter(mut self, gutter: bool) -> Row {
		self.gutter = gutter;
		self
	}

	/// A second line under the title: a preview, a path, a time.
	pub fn note(mut self, note: impl Into<SharedString>) -> Row {
		self.note = Some(note.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Row {
		self.tone = tone;
		self
	}

	/// What the keyboard is on. Drawn as a wash, because the pointer's hover is
	/// the same claim made by a different device.
	pub fn selected(mut self, selected: bool) -> Row {
		self.selected = selected;
		self
	}

	/// What the window is showing. Drawn with a fill that stays under the
	/// pointer's wash, so a hovered row that is open reads as both.
	pub fn active(mut self, active: bool) -> Row {
		self.active = active;
		self
	}

	pub fn depth(mut self, depth: u8) -> Row {
		self.depth = depth;
		self
	}

	pub fn arriving(mut self) -> Row {
		self.arrives = true;
		self
	}

	/// A control that appears when the pointer is on the row, at the opacity of
	/// the row's own wash.
	///
	/// The row holds the value, because a caller that reads the wash itself has
	/// to name the channel the row drives, and a name that agrees today is a
	/// control that silently stops appearing the day the row renames its own.
	pub fn hovered_child(mut self, element: impl IntoElement) -> Row {
		self.hovered.push(element.into_any_element());
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Row {
		self.on_click = Some(Box::new(listener));
		self
	}
}

/// The far end of a row: a badge, a count, a button that appears on hover.
impl ParentElement for Row {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.trailing.extend(elements);
	}
}

impl RenderOnce for Row {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let wash = Key::named(Channel::Row, self.id.as_ref());
		let ink = self.tone.ink(&theme);

		let rest = if self.active {
			theme.selected()
		} else {
			gpui::transparent_black()
		};
		let lit = if self.active {
			theme.selected()
		} else {
			theme.hover()
		};
		let hover = paint::at(cx, wash);
		let ground = if self.selected {
			lit
		} else {
			motion::mix(rest, lit, hover)
		};

		let arrival = if self.arrives {
			paint::arriving(cx, Key::named(Channel::RowEnter, self.id.as_ref()), motion::ENTER)
		} else {
			1.0
		};

		let tall = self.note.is_some();
		let mut row = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.w_full()
			.h(px(if tall { layout::ROW_TALL } else { layout::ROW }))
			.pl(px(space::BASE + f32::from(self.depth) * space::WIDE))
			.pr(px(space::SNUG))
			.rounded(px(radius::ROW))
			.bg(ground)
			.cursor_pointer()
			.on_hover(move |over, _window, cx| {
				paint::hover(cx, wash, *over);
				cx.refresh_windows();
			})
			.children(
				self
					.icon
					.map(|glyph| square(icon::scale::BASE).child(icon::base(glyph, theme.text_faint)))
					.or_else(|| self.gutter.then(|| square(icon::scale::BASE))),
			)
			.child(
				text::stack(space::PAIR)
					.flex_1()
					.overflow_hidden()
					.child(
						text::line(self.title)
							.text_size(px(size::BODY))
							.line_height(px(size::BODY * size::LINE_TIGHT))
							.text_color(ink),
					)
					.children(self.note.map(|note| text::note(note, &theme))),
			)
			.children(self.trailing)
			// The pointer's own controls, at the pointer's own opacity. The row
			// holds the value, so nothing outside has to name the channel it
			// drives: a caller deriving the same key by hand and getting a
			// different one is a control that never appears.
			.children((hover > 0.02 && !self.hovered.is_empty()).then(|| {
				div()
					.opacity(hover)
					.flex()
					.items_center()
					.children(self.hovered)
			}));

		if arrival < 1.0 {
			row = row.opacity(arrival);
		}

		match self.on_click {
			Some(listener) => row.on_click(move |event, window, cx| listener(event, window, cx)),
			None => row,
		}
	}
}
