//! Stable list and tree rows.
//!
//! A row reserves its metadata geometry. Hover actions are painted in an
//! absolute trailing slot, so entering the row never moves, clips, or rewraps
//! the title, note, count, or status. Collection entrances and reorder motion
//! are registered from model events through `motion::CollectionPlan`, not here.

use gpui::{
	AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Tone, icon, square, text};
use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, layout, radius, size, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Row {
	id:                SharedString,
	owner:             RetainedKey,
	icon:              Option<Icon>,
	gutter:            bool,
	title:             Option<SharedString>,
	title_element:     Option<AnyElement>,
	note:              Option<SharedString>,
	trailing:          Vec<AnyElement>,
	hovered:           Vec<AnyElement>,
	hover_slot:        f32,
	tone:              Tone,
	selected:          bool,
	active:            bool,
	focused:           bool,
	destructive_armed: bool,
	depth:             u8,
	disabled_reason:   Option<SharedString>,
	on_click:          Option<Click>,
}

impl Row {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		title: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			icon: None,
			gutter: false,
			title: Some(title.into()),
			title_element: None,
			note: None,
			trailing: Vec::new(),
			hovered: Vec::new(),
			hover_slot: layout::control_height(),
			tone: Tone::Plain,
			selected: false,
			active: false,
			focused: false,
			destructive_armed: false,
			depth: 0,
			disabled_reason: None,
			on_click: None,
		}
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn gutter(mut self, gutter: bool) -> Self {
		self.gutter = gutter;
		self
	}

	pub fn note(mut self, note: impl Into<SharedString>) -> Self {
		self.note = Some(note.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	pub fn active(mut self, active: bool) -> Self {
		self.active = active;
		self
	}

	pub fn focused(mut self, focused: bool) -> Self {
		self.focused = focused;
		self
	}

	pub fn destructive_armed(mut self, armed: bool) -> Self {
		self.destructive_armed = armed;
		self
	}

	pub fn depth(mut self, depth: u8) -> Self {
		self.depth = depth;
		self
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.disabled_reason = Some(reason.into());
		self
	}

	/// Replace the title run with a highlighted or otherwise styled element.
	/// The element receives the same flex/min-width clipping container as text.
	pub fn title_element(mut self, element: impl IntoElement) -> Self {
		self.title = None;
		self.title_element = Some(element.into_any_element());
		self
	}

	/// Add actions to the fixed overlay slot. `width` is a named token selected
	/// by the parent surface, commonly one or two control heights.
	pub fn hover_actions(mut self, width: f32, element: impl IntoElement) -> Self {
		self.hover_slot = width;
		self.hovered.push(element.into_any_element());
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

impl ParentElement for Row {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.trailing.extend(elements);
	}
}

impl RenderOnce for Row {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::ColorMix);
		let ink = self.tone.ink(&theme);
		let base_selected = self.selected || self.active;
		let rest = if self.destructive_armed {
			Tone::Danger.tint(&theme)
		} else if base_selected {
			theme.selected()
		} else {
			gpui::transparent_black()
		};
		let lit = if self.destructive_armed {
			Tone::Danger.ink(&theme)
		} else if base_selected {
			theme.selected_hover()
		} else {
			theme.hover()
		};
		let live =
			self.disabled_reason.is_none() && (self.on_click.is_some() || !self.hovered.is_empty());
		let hover = if live {
			paint::sample(cx, key, 0.0)
		} else {
			0.0
		};
		let ground = mix(rest, lit, hover);
		let tall = self.note.is_some();
		let title = self
			.title
			.map(|value| {
				text::line(value)
					.text_size(px(size::body()))
					.line_height(px(size::body() * size::LINE_CHROME))
					.text_color(ink)
					.into_any_element()
			})
			.or(self.title_element);
		let note = self.note.map(|value| text::note(value, &theme));
		let has_hovered = !self.hovered.is_empty();
		let hover_slot = self.hover_slot;
		let mut row = div()
			.id(ElementId::from(self.id.clone()))
			.relative()
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.w_full()
			.h(px(if tall {
				layout::row_tall()
			} else {
				layout::row()
			}))
			.pl(px(space::BASE + f32::from(self.depth) * space::WIDE))
			.pr(px(if has_hovered {
				hover_slot + space::SNUG
			} else {
				space::SNUG
			}))
			.rounded(px(radius::ROW))
			.bg(ground)
			.children(
				self
					.icon
					.map(|glyph| square(icon::scale::base()).child(icon::base(glyph, theme.text_faint)))
					.or_else(|| self.gutter.then(|| square(icon::scale::base()))),
			)
			.child(
				text::stack(space::PAIR)
					.flex_1()
					.min_w(px(0.0))
					.overflow_hidden()
					.children(title)
					.children(note),
			)
			.children(self.trailing)
			.children(has_hovered.then(|| {
				div()
					.absolute()
					.right(px(space::SNUG))
					.top(px(0.0))
					.h_full()
					.w(px(hover_slot))
					.flex()
					.items_center()
					.justify_end()
					.opacity(hover)
					.children(self.hovered)
			}));
		if self.focused {
			row = row.shadow(theme.focus_ring());
		}
		if live {
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
		if self.on_click.is_some() && self.disabled_reason.is_none() {
			row = row.cursor_pointer();
		}
		let row = match self.disabled_reason {
			Some(reason) => row.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => row,
		};
		match (self.on_click, live) {
			(Some(listener), true) => {
				row.on_click(move |event, window, cx| listener(event, window, cx))
			},
			_ => row,
		}
	}
}
