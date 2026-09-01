//! Toggle switch primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Boolean toggle switch element.
#[derive(IntoElement)]
pub struct Toggle {
	id:        Option<ElementId>,
	checked:   bool,
	state:     InteractiveState,
	on_toggle: Option<Arc<dyn Fn(bool, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Toggle {
	/// Creates a toggle switch with state.
	#[must_use]
	pub fn new(checked: bool) -> Self {
		Self { id: None, checked, state: InteractiveState::default(), on_toggle: None }
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets toggle handler.
	#[must_use]
	pub fn on_toggle(
		mut self,
		handler: impl Fn(bool, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_toggle = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Toggle {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let track_w = tokens.spacing(SpacingStep::S8);
		let track_h = tokens.spacing(SpacingStep::S5);
		let thumb_size = tokens.spacing(SpacingStep::S4);
		let radius = tokens.radius(RadiusStep::Full);
		let pad = tokens.spacing(SpacingStep::S1);

		let track_bg = if self.checked {
			tokens.color(ColorRole::Accent)
		} else {
			tokens.color(ColorRole::Inset)
		};

		let thumb = div()
			.size(thumb_size)
			.rounded(radius)
			.bg(tokens.color(ColorRole::Foreground))
			.shadow_sm();

		let id = self.id.unwrap_or_else(|| ElementId::from("toggle"));
		let mut track = div()
			.id(id)
			.w(track_w)
			.h(track_h)
			.rounded(radius)
			.bg(track_bg)
			.p(pad)
			.flex()
			.items_center()
			.cursor_pointer();

		if self.checked {
			track = track.justify_end();
		} else {
			track = track.justify_start();
		}

		track = track.child(thumb);

		if let Some(handler) = self.on_toggle {
			let next_state = !self.checked;
			track = track.on_click(move |_, window, cx| handler(next_state, window, cx));
		}

		track
	}
}
