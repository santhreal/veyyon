//! Icon button primitive (§8.25).

use veyyon_gpui::{
	App, ClickEvent, CursorStyle, ElementId, IntoElement, RenderOnce, Window, div, prelude::*,
};

use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Visual variant for icon buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum IconButtonVariant {
	#[default]
	Ghost,
	Subtle,
	Solid,
}

/// Compact button containing only an icon.
#[derive(IntoElement)]
pub struct IconButton {
	id:       Option<ElementId>,
	icon:     IconName,
	size:     IconSize,
	variant:  IconButtonVariant,
	state:    InteractiveState,
	on_click: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
}

impl IconButton {
	/// Creates an icon button.
	#[must_use]
	pub fn new(icon: IconName) -> Self {
		Self {
			id: None,
			icon,
			size: IconSize::default(),
			variant: IconButtonVariant::default(),
			state: InteractiveState::default(),
			on_click: None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets icon size.
	#[must_use]
	pub fn size(mut self, size: IconSize) -> Self {
		self.size = size;
		self
	}

	/// Sets visual variant.
	#[must_use]
	pub fn variant(mut self, variant: IconButtonVariant) -> Self {
		self.variant = variant;
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets click handler.
	#[must_use]
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for IconButton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		// §6.10: `Solid` is the one accent fill, `Subtle` is a hairline-edged
		// secondary, `Ghost` is ink alone. None fills with a neutral ground.
		let (bg, edge, fg) = match self.variant {
			IconButtonVariant::Solid => (
				tokens.color(ColorRole::Accent),
				tokens.transparent(),
				tokens.color(ColorRole::AccentForeground),
			),
			IconButtonVariant::Subtle => (
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Foreground),
			),
			IconButtonVariant::Ghost => {
				(tokens.transparent(), tokens.transparent(), tokens.color(ColorRole::Secondary))
			},
		};
		let hover_bg = if self.variant == IconButtonVariant::Solid {
			tokens.color(ColorRole::Focus)
		} else {
			tokens.row_hover()
		};
		let disabled = self.state == InteractiveState::Disabled;

		// A square whose side is the control height of the size the icon
		// implies, so an icon button sits flush beside a text button.
		let size = match self.size {
			IconSize::Size12 => ButtonSize::Small,
			IconSize::Size14 => ButtonSize::Medium,
			IconSize::Size16 | IconSize::Size20 => ButtonSize::Large,
		};
		let metrics = control_metrics(size, tokens);
		let cursor = if disabled {
			CursorStyle::OperationNotAllowed
		} else {
			CursorStyle::PointingHand
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("icon-button"));
		let mut el = div()
			.id(id)
			.w(metrics.square)
			.h(metrics.square)
			.flex_shrink_0()
			.rounded(metrics.radius)
			.bg(bg)
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(edge)
			.flex()
			.items_center()
			.justify_center()
			.cursor(cursor)
			.child(Icon::new(self.icon).size(self.size).color(fg));

		if disabled {
			el = el.opacity(metrics.disabled_opacity);
		} else {
			el = el.hover(move |style| style.bg(hover_bg));
			if let Some(handler) = self.on_click {
				el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
			}
		}

		el
	}
}
