//! NumberInput stepper control primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Numeric input field with increment/decrement stepper controls.
#[derive(IntoElement)]
pub struct NumberInput {
	value:     i64,
	min:       i64,
	max:       i64,
	step:      i64,
	disabled:  bool,
	on_change: Option<Box<dyn Fn(i64, &mut Window, &mut App) + 'static>>,
}

impl NumberInput {
	/// Creates a number input with initial value.
	#[must_use]
	pub fn new(value: i64) -> Self {
		Self { value, min: i64::MIN, max: i64::MAX, step: 1, disabled: false, on_change: None }
	}

	/// Sets minimum and maximum value bounds.
	#[must_use]
	pub fn range(mut self, min: i64, max: i64) -> Self {
		self.min = min;
		self.max = max;
		self
	}

	/// Sets stepper increment/decrement step.
	#[must_use]
	pub fn step(mut self, step: i64) -> Self {
		self.step = step;
		self
	}

	/// Configures disabled state.
	#[must_use]
	pub fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Attaches value change event handler.
	#[must_use]
	pub fn on_change(mut self, handler: impl Fn(i64, &mut Window, &mut App) + 'static) -> Self {
		self.on_change = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for NumberInput {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let fg = tokens.color(ColorRole::Foreground);
		let radius = tokens.radius(RadiusStep::Md);
		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let font_size = tokens.font_size(TextRamp::Body);

		let value_text = self.value.to_string();

		let dec_btn = div()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Xs))
			.cursor_pointer()
			.child(
				Icon::new(IconName::Minus)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Muted)),
			);

		let inc_btn = div()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Xs))
			.cursor_pointer()
			.child(
				Icon::new(IconName::Plus)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Muted)),
			);

		let mut container = div()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.flex()
			.flex_row()
			.items_center()
			.justify_between()
			.child(div().text_size(font_size).text_color(fg).child(value_text))
			.child(
				div()
					.flex()
					.flex_row()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S1))
					.child(dec_btn)
					.child(inc_btn),
			);

		if self.disabled {
			container = container.opacity(0.4).cursor_not_allowed();
		}

		container
	}
}
