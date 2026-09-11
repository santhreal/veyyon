//! One announcement's card, as drawn in the stack (§8.26).
//!
//! A toast states a line, the detail under it when it has one, and the tint of
//! the thing it is announcing. It is a card and not a container: the stack that
//! places it owns where it sits and how many of them are drawn, so a toast
//! never reads the window's size or decides its own corner.
//!
//! The card carries its entrance whole, ground and text together, the way the
//! popover does: a transition on the text alone draws a card that was already
//! there with its words arriving inside it.

use std::rc::Rc;

use veyyon_desktop_motion::FloatFrame;
use veyyon_gpui::{
	App, IntoElement, MouseButton, MouseDownEvent, RenderOnce, SharedString, Window, div,
	prelude::*, px,
};

use crate::token_set::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet,
};

/// How wide a toast is drawn, in pixels of the window it is stacked in.
///
/// An announcement is one line and its detail, so the card is narrower than a
/// dialog and wider than a chip: wide enough for a sentence that is read at a
/// glance without reflowing into four lines.
pub const TOAST_WIDTH_PX: f32 = 320.0;

/// One announcement's card.
#[derive(IntoElement)]
pub struct Toast {
	id:         SharedString,
	title:      SharedString,
	detail:     Option<SharedString>,
	tint:       TintRole,
	entrance:   Option<FloatFrame>,
	on_dismiss: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
}

impl Toast {
	/// Creates a toast stating `title`.
	#[must_use]
	pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
		Self {
			id:         id.into(),
			title:      title.into(),
			detail:     None,
			tint:       TintRole::Attention,
			entrance:   None,
			on_dismiss: None,
		}
	}

	/// States what the line left out, drawn under it.
	#[must_use]
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	/// Draws the card on `tint` rather than the attention tint.
	#[must_use]
	pub const fn tint(mut self, tint: TintRole) -> Self {
		self.tint = tint;
		self
	}

	/// Applies the frame the stack's motion driver sampled.
	#[must_use]
	pub const fn entrance(mut self, frame: FloatFrame) -> Self {
		self.entrance = Some(frame);
		self
	}

	/// Answers a press on the card by dismissing the announcement.
	#[must_use]
	pub fn on_dismiss(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
		self.on_dismiss = Some(Rc::new(handler));
		self
	}
}

impl RenderOnce for Toast {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved;
		let tint = tokens.tint(self.tint);

		let mut card = div()
			.id(self.id)
			.occlude()
			.w(px(TOAST_WIDTH_PX))
			.bg(tint.fill)
			.rounded(tokens.radius(RadiusStep::Lg))
			.border_1()
			.border_color(tokens.color(ColorRole::Hairline))
			.p(tokens.spacing(SpacingStep::S3))
			.shadow_lg()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S1))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.text_color(tint.ink)
					.child(self.title),
			);
		if let Some(detail) = self.detail {
			card = card.child(
				div()
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(detail),
			);
		}
		if let Some(frame) = self.entrance {
			card = card.opacity(frame.opacity).translate_y(px(frame.offset_y));
		}
		if let Some(handler) = self.on_dismiss {
			card =
				card.on_mouse_down(MouseButton::Left, move |_event: &MouseDownEvent, window, cx| {
					handler(window, cx);
				});
		}
		card
	}
}
