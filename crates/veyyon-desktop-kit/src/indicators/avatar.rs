//! Avatar representation primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::ImageSource,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Size ramp for avatar circular frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AvatarSize {
	Small,
	#[default]
	Medium,
	Large,
}

impl AvatarSize {
	/// Resolves avatar dimension in spacing steps.
	#[must_use]
	pub const fn to_spacing_step(self) -> SpacingStep {
		match self {
			Self::Small => SpacingStep::S6,
			Self::Medium => SpacingStep::S8,
			Self::Large => SpacingStep::S10,
		}
	}
}

/// Circular user or agent avatar container.
#[derive(IntoElement)]
pub struct Avatar {
	initials: Option<SharedString>,
	image:    Option<ImageSource>,
	size:     AvatarSize,
}

impl Avatar {
	/// Creates an avatar with initials fallback.
	#[must_use]
	pub fn new(initials: impl Into<SharedString>) -> Self {
		Self { initials: Some(initials.into()), image: None, size: AvatarSize::default() }
	}

	/// Sets avatar size ramp.
	#[must_use]
	pub fn size(mut self, size: AvatarSize) -> Self {
		self.size = size;
		self
	}

	/// Sets avatar image source.
	#[must_use]
	pub fn image(mut self, image: ImageSource) -> Self {
		self.image = Some(image);
		self
	}

	/// Returns image source if set.
	#[must_use]
	pub fn image_source(&self) -> Option<&ImageSource> {
		self.image.as_ref()
	}
}

impl RenderOnce for Avatar {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let dimension = tokens.spacing(self.size.to_spacing_step());
		let radius = tokens.radius(RadiusStep::Full);
		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let fg = tokens.color(ColorRole::Foreground);

		let font_ramp = match self.size {
			AvatarSize::Small => TextRamp::Micro,
			AvatarSize::Medium => TextRamp::Small,
			AvatarSize::Large => TextRamp::Body,
		};

		let label = self.initials.unwrap_or_default();

		div()
			.size(dimension)
			.rounded(radius)
			.bg(bg)
			.border_1()
			.border_color(border_color)
			.flex()
			.items_center()
			.justify_center()
			.text_size(tokens.font_size(font_ramp))
			.text_color(fg)
			.child(label)
	}
}
