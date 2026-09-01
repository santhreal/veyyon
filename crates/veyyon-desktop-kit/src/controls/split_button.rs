//! SplitButton primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	App, ClickEvent, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
};

pub use crate::state::ButtonVariant;
use crate::{
	controls::ButtonSize,
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TokenSet},
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
	on_primary:   Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
	on_secondary: Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
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
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_primary = Some(Arc::new(handler));
		self
	}

	/// Sets secondary dropdown trigger click callback.
	#[must_use]
	pub fn on_secondary(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_secondary = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for SplitButton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let (pad_x, pad_y, radius, ramp, icon_size) = match self.size {
			ButtonSize::Small => (
				tokens.spacing(SpacingStep::S2),
				tokens.spacing(SpacingStep::S1),
				tokens.radius(RadiusStep::Sm),
				TextRamp::Small,
				IconSize::Size12,
			),
			ButtonSize::Medium => (
				tokens.spacing(SpacingStep::S3),
				tokens.spacing(SpacingStep::S2),
				tokens.radius(RadiusStep::Md),
				TextRamp::Body,
				IconSize::Size14,
			),
			ButtonSize::Large => (
				tokens.spacing(SpacingStep::S4),
				tokens.spacing(SpacingStep::S3),
				tokens.radius(RadiusStep::Lg),
				TextRamp::Read,
				IconSize::Size16,
			),
		};

		let (bg, fg, divider_color) = match (self.variant, self.state) {
			(_, InteractiveState::Disabled) => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Muted),
				tokens.color(ColorRole::Hairline),
			),
			(ButtonVariant::Primary, _) => (
				tokens.color(ColorRole::Accent),
				tokens.color(ColorRole::AccentForeground),
				tokens.color(ColorRole::Hairline),
			),
			(ButtonVariant::Danger, _) => (
				tokens.color(ColorRole::ErrorFill),
				tokens.color(ColorRole::ErrorInk),
				tokens.color(ColorRole::Hairline),
			),
			(ButtonVariant::Ghost, _) => (
				tokens.transparent(),
				tokens.color(ColorRole::Foreground),
				tokens.color(ColorRole::Hairline),
			),
			(ButtonVariant::Default, _) => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Foreground),
				tokens.color(ColorRole::Hairline),
			),
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("split-button"));
		let stroke_px = tokens.stroke(StrokeStep::Hairline);

		let mut primary_el = div()
			.id(ElementId::from("split-button-primary"))
			.px(pad_x)
			.py(pad_y)
			.flex()
			.items_center()
			.justify_center()
			.cursor_pointer()
			.child(self.label);

		if let Some(handler) = self.on_primary {
			primary_el = primary_el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		let mut secondary_el = div()
			.id(ElementId::from("split-button-secondary"))
			.px(pad_y)
			.py(pad_y)
			.flex()
			.items_center()
			.justify_center()
			.cursor_pointer()
			.child(Icon::new(IconName::ChevronDown).size(icon_size));

		if let Some(handler) = self.on_secondary {
			secondary_el = secondary_el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		div()
			.id(id)
			.bg(bg)
			.rounded(radius)
			.text_color(fg)
			.text_size(tokens.font_size(ramp))
			.line_height(tokens.line_height(ramp))
			.flex()
			.items_center()
			.child(primary_el)
			.child(div().w(stroke_px).h_full().bg(divider_color))
			.child(secondary_el)
	}
}
