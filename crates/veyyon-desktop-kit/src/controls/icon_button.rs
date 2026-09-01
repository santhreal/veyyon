//! Icon button primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ClickEvent, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
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
	on_click: Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
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
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_click = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for IconButton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let (bg, fg) = match (self.variant, self.state) {
			(_, InteractiveState::Disabled) => (tokens.transparent(), tokens.color(ColorRole::Muted)),
			(IconButtonVariant::Solid, _) => {
				(tokens.color(ColorRole::Accent), tokens.color(ColorRole::AccentForeground))
			},
			(IconButtonVariant::Subtle, _) => {
				(tokens.color(ColorRole::Inset), tokens.color(ColorRole::Foreground))
			},
			(IconButtonVariant::Ghost, _) => {
				(tokens.transparent(), tokens.color(ColorRole::Secondary))
			},
		};

		let pad = tokens.spacing(SpacingStep::S1);
		let radius = tokens.radius(RadiusStep::Sm);

		let id = self.id.unwrap_or_else(|| ElementId::from("icon-button"));
		let mut el = div()
			.id(id)
			.p(pad)
			.rounded(radius)
			.flex()
			.items_center()
			.justify_center()
			.bg(bg)
			.cursor_pointer()
			.child(Icon::new(self.icon).size(self.size).color(fg));

		if let Some(handler) = self.on_click {
			el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		el
	}
}
