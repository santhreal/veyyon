//! SplitButton primitive (§8.25).

use veyyon_gpui::{
	App, ClickEvent, CursorStyle, ElementId, IntoElement, RenderOnce, SharedString, Window, div,
	prelude::*,
};

pub use crate::state::ButtonVariant;
use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TintRole, TokenSet},
};

/// Interactive split button primitive combining a primary action button with a
/// secondary dropdown trigger element.
#[derive(IntoElement)]
pub struct SplitButton {
	id:           Option<ElementId>,
	label:        SharedString,
	variant:      ButtonVariant,
	size:         ButtonSize,
	state:        InteractiveState,
	on_primary:   Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
	on_secondary: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
}

impl SplitButton {
	/// Creates a split button with primary label text.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self {
			id:           None,
			label:        label.into(),
			variant:      ButtonVariant::default(),
			size:         ButtonSize::default(),
			state:        InteractiveState::default(),
			on_primary:   None,
			on_secondary: None,
		}
	}

	/// Sets the element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets visual variant.
	#[must_use]
	pub fn variant(mut self, variant: ButtonVariant) -> Self {
		self.variant = variant;
		self
	}

	/// Sets button size.
	#[must_use]
	pub fn size(mut self, size: ButtonSize) -> Self {
		self.size = size;
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets primary action click callback.
	#[must_use]
	pub fn on_primary(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_primary = Some(Box::new(handler));
		self
	}

	/// Sets secondary dropdown trigger click callback.
	#[must_use]
	pub fn on_secondary(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_secondary = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for SplitButton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let metrics = control_metrics(self.size, tokens);
		let icon_size = match self.size {
			ButtonSize::Small => IconSize::Size12,
			ButtonSize::Medium => IconSize::Size14,
			ButtonSize::Large => IconSize::Size16,
		};

		// The same ladder as `Button` (§6.10): the two halves share one ground
		// and one edge. The divider is the hairline on a quiet variant and the
		// edge colour on a destructive one; on the accent fill it is the
		// accent's own ink at a third, so it reads as a seam, not a stripe.
		let error = tokens.tint(TintRole::Error);
		let mut accent_seam = tokens.color(ColorRole::AccentForeground);
		accent_seam.a = 0.3;
		let (bg, edge, fg, hover_bg, divider) = match self.variant {
			ButtonVariant::Primary => (
				tokens.color(ColorRole::Accent),
				tokens.transparent(),
				tokens.color(ColorRole::AccentForeground),
				tokens.color(ColorRole::Focus),
				accent_seam,
			),
			ButtonVariant::Default => (
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Foreground),
				tokens.row_hover(),
				tokens.color(ColorRole::Hairline),
			),
			ButtonVariant::Ghost => (
				tokens.transparent(),
				tokens.transparent(),
				tokens.color(ColorRole::Secondary),
				tokens.row_hover(),
				tokens.color(ColorRole::Hairline),
			),
			ButtonVariant::Danger => {
				(tokens.transparent(), error.fill, error.ink, error.fill, error.fill)
			},
		};
		let disabled = self.state == InteractiveState::Disabled;

		let id = self.id.unwrap_or_else(|| ElementId::from("split-button"));
		let stroke_px = tokens.stroke(StrokeStep::Hairline);
		let cursor = if disabled {
			CursorStyle::OperationNotAllowed
		} else {
			CursorStyle::PointingHand
		};

		let mut primary_el = div()
			.id(ElementId::from("split-button-primary"))
			.h_full()
			.px(metrics.inset)
			.flex()
			.items_center()
			.justify_center()
			.cursor(cursor)
			.child(self.label);
		let mut secondary_el = div()
			.id(ElementId::from("split-button-secondary"))
			.h_full()
			.w(metrics.square)
			.flex()
			.items_center()
			.justify_center()
			.cursor(cursor)
			.child(Icon::new(IconName::ChevronDown).size(icon_size).color(fg));

		if !disabled {
			primary_el = primary_el.hover(move |style| style.bg(hover_bg));
			secondary_el = secondary_el.hover(move |style| style.bg(hover_bg));
			if let Some(handler) = self.on_primary {
				primary_el = primary_el.on_click(move |ev, window, cx| handler(ev, window, cx));
			}
			if let Some(handler) = self.on_secondary {
				secondary_el = secondary_el.on_click(move |ev, window, cx| handler(ev, window, cx));
			}
		}

		// The height is set on the outer element; each half fills it, so the
		// divider is exactly the control's height and the halves share a
		// baseline. The radius clips the halves' hover wash to the corners.
		let mut el = div()
			.id(id)
			.h(metrics.height)
			.bg(bg)
			.border(stroke_px)
			.border_color(edge)
			.rounded(metrics.radius)
			.overflow_hidden()
			.text_color(fg)
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp))
			.flex()
			.items_center()
			.child(primary_el)
			.child(div().w(stroke_px).h_full().bg(divider))
			.child(secondary_el);
		if disabled {
			el = el.opacity(metrics.disabled_opacity);
		}
		el
	}
}
