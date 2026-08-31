//! Floating transient notification toasts.
//!
//! A toast informs the user of an event, failure, or completion. It animates
//! into view on its own motion track, presents a tone-tinted border, a title
//! line, an optional truncated detail line, an optional action control, and a
//! dismiss button.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, Styled, Window, div, px,
};

use super::{
	Badge, Button, Fill, Icon, Size, Tone, icon,
	surface::{Float, Floating},
	text,
};
use crate::{
	motion::{MotionKey, OwnerNamespace, Property, RetainedKey, control},
	paint,
	theme::{Theme, radius, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// Slot offsets for controls inside a toast's motion block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ToastSlot {
	Dismiss = 1,
	Action  = 2,
}

impl ToastSlot {
	pub const ALL: [ToastSlot; 2] = [ToastSlot::Dismiss, ToastSlot::Action];

	pub const fn offset(self) -> u8 {
		self as u8
	}

	pub const fn name(self) -> &'static str {
		match self {
			ToastSlot::Dismiss => "dismiss",
			ToastSlot::Action => "action",
		}
	}
}

/// A transient notification toast.
#[derive(IntoElement)]
pub struct Toast {
	id:           SharedString,
	owner:        RetainedKey,
	tone:         Tone,
	title:        SharedString,
	detail:       Option<SharedString>,
	count:        u32,
	action_label: Option<SharedString>,
	on_action:    Option<Click>,
	on_dismiss:   Option<Click>,
}

impl Toast {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		title: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			tone: Tone::Plain,
			title: title.into(),
			detail: None,
			count: 1,
			action_label: None,
			on_action: None,
			on_dismiss: None,
		}
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	pub fn count(mut self, count: u32) -> Self {
		self.count = count;
		self
	}

	pub fn action(
		mut self,
		label: impl Into<SharedString>,
		on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.action_label = Some(label.into());
		self.on_action = Some(Box::new(on_click));
		self
	}

	pub fn on_dismiss(
		mut self,
		on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_dismiss = Some(Box::new(on_click));
		self
	}

	fn tone_icon(&self) -> Icon {
		match self.tone {
			Tone::Ok => Icon::Check,
			Tone::Warn => Icon::Notice,
			Tone::Danger => Icon::Failed,
			Tone::Accent | Tone::Plain | Tone::Muted => Icon::Notice,
		}
	}
}

impl RenderOnce for Toast {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let opacity = paint::sample(cx, MotionKey::new(self.owner, Property::Opacity), 1.0);
		let translation_y = paint::sample(cx, MotionKey::new(self.owner, Property::TranslateY), 0.0);

		let dismiss_owner =
			control(OwnerNamespace::Overlays, "toast", self.id.as_ref(), ToastSlot::Dismiss.offset());
		let action_owner =
			control(OwnerNamespace::Overlays, "toast", self.id.as_ref(), ToastSlot::Action.offset());

		let glyph = self.tone_icon();
		let ink = self.tone.ink(&theme);

		let mut title_row = div().flex().items_center().gap(px(space::TIGHT)).child(
			text::line(self.title)
				.text_size(px(size::body()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text),
		);

		if self.count > 1 {
			title_row = title_row.child(
				Badge::new(format!("×{}", self.count))
					.tone(self.tone)
					.size(Size::Small),
			);
		}

		let mut text_column = div()
			.flex()
			.flex_col()
			.flex_1()
			.min_w(px(0.0))
			.gap(px(space::TIGHT))
			.child(title_row);

		if let Some(detail) = self.detail {
			text_column = text_column.child(
				text::line(detail)
					.text_size(px(size::meta()))
					.text_color(theme.text_muted),
			);
		}

		let mut controls_row = div().flex().items_center().gap(px(space::TIGHT));

		if let (Some(label), Some(action_click)) = (self.action_label, self.on_action) {
			let button = Button::labelled(format!("{}-action", self.id), action_owner, label)
				.size(Size::Small)
				.tone(self.tone)
				.fill(Fill::Tinted)
				.on_click(move |ev, window, cx| action_click(ev, window, cx));
			controls_row = controls_row.child(button);
		}

		if let Some(dismiss_click) = self.on_dismiss {
			let dismiss_btn = Button::new(format!("{}-dismiss", self.id), dismiss_owner, Icon::Close)
				.size(Size::Small)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip("Dismiss")
				.on_click(move |ev, window, cx| dismiss_click(ev, window, cx));
			controls_row = controls_row.child(dismiss_btn);
		}

		div()
			.id(ElementId::from(self.id))
			.flex()
			.items_start()
			.gap(px(space::BASE))
			.w(px(320.0))
			.p(px(space::BASE))
			.floating(&theme, Float::Menu, radius::CARD)
			// The tone is the toast's own edge, so it keeps the float's face and
			// its shadow and states its status in the border.
			.border_color(self.tone.tint(&theme))
			.opacity(opacity)
			.relative()
			.top(px(translation_y))
			.child(
				div()
					.mt(px(1.0))
					.child(icon::at(glyph, icon::scale::base(), ink)),
			)
			.child(text_column)
			.child(controls_row)
	}
}
