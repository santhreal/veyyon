//! Button primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, RenderOnce, SharedString, Window, div,
	prelude::*,
};

pub use crate::state::ButtonVariant;
use crate::{
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Size ramp for button padding and typography.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ButtonSize {
	Small,
	#[default]
	Medium,
	Large,
}

/// Interactive button primitive element.
#[derive(IntoElement)]
pub struct Button {
	id:          Option<ElementId>,
	label:       Option<SharedString>,
	variant:     ButtonVariant,
	size:        ButtonSize,
	state:       InteractiveState,
	leading:     Option<AnyElement>,
	trailing:    Option<AnyElement>,
	on_click:    Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
	block_width: bool,
}

impl Button {
	/// Creates a button with a text label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self {
			id:          None,
			label:       Some(label.into()),
			variant:     ButtonVariant::default(),
			size:        ButtonSize::default(),
			state:       InteractiveState::default(),
			leading:     None,
			trailing:    None,
			on_click:    None,
			block_width: false,
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

	/// Sets leading icon.
	#[must_use]
	pub fn leading_icon(mut self, icon: IconName) -> Self {
		let icon_size = match self.size {
			ButtonSize::Small => IconSize::Size12,
			ButtonSize::Medium => IconSize::Size14,
			ButtonSize::Large => IconSize::Size16,
		};
		self.leading = Some(Icon::new(icon).size(icon_size).into_any_element());
		self
	}

	/// Sets leading arbitrary element.
	#[must_use]
	pub fn leading(mut self, element: impl IntoElement) -> Self {
		self.leading = Some(element.into_any_element());
		self
	}

	/// Sets trailing arbitrary element.
	#[must_use]
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Sets click handler.
	#[must_use]
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_click = Some(Arc::new(handler));
		self
	}

	/// Sets whether button stretches full width.
	#[must_use]
	pub fn block(mut self, block: bool) -> Self {
		self.block_width = block;
		self
	}
}

impl RenderOnce for Button {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let (pad_x, pad_y, radius, ramp) = match self.size {
			ButtonSize::Small => (
				tokens.spacing(SpacingStep::S2),
				tokens.spacing(SpacingStep::S1),
				tokens.radius(RadiusStep::Sm),
				TextRamp::Small,
			),
			ButtonSize::Medium => (
				tokens.spacing(SpacingStep::S3),
				tokens.spacing(SpacingStep::S2),
				tokens.radius(RadiusStep::Md),
				TextRamp::Body,
			),
			ButtonSize::Large => (
				tokens.spacing(SpacingStep::S4),
				tokens.spacing(SpacingStep::S3),
				tokens.radius(RadiusStep::Lg),
				TextRamp::Read,
			),
		};

		let (bg, fg) = match (self.variant, self.state) {
			(_, InteractiveState::Disabled) => {
				(tokens.color(ColorRole::Inset), tokens.color(ColorRole::Muted))
			},
			(ButtonVariant::Primary, _) => {
				(tokens.color(ColorRole::Accent), tokens.color(ColorRole::AccentForeground))
			},
			(ButtonVariant::Danger, _) => {
				(tokens.color(ColorRole::ErrorFill), tokens.color(ColorRole::ErrorInk))
			},
			(ButtonVariant::Ghost, _) => (tokens.transparent(), tokens.color(ColorRole::Foreground)),
			(ButtonVariant::Default, _) => {
				(tokens.color(ColorRole::Inset), tokens.color(ColorRole::Foreground))
			},
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("button"));
		let mut el = div()
			.id(id)
			.bg(bg)
			.rounded(radius)
			.px(pad_x)
			.py(pad_y)
			.flex()
			.items_center()
			.justify_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.text_color(fg)
			.text_size(tokens.font_size(ramp))
			.line_height(tokens.line_height(ramp))
			.cursor_pointer();

		if self.block_width {
			el = el.w_full();
		}

		if let Some(leading) = self.leading {
			el = el.child(leading);
		}

		if let Some(label) = self.label {
			el = el.child(
				div()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.child(label),
			);
		}

		if let Some(trailing) = self.trailing {
			el = el.child(trailing);
		}

		if let Some(handler) = self.on_click {
			el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		el
	}
}
