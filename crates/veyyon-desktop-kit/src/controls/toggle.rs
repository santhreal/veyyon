//! Toggle switch primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	App, CursorStyle, ElementId, IntoElement, RenderOnce, Window, div, prelude::*, px,
};

use crate::{
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, StrokeStep, TokenSet},
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
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		// §6.10: a 26 × 16 track with a 12px knob. On is an accent track with a
		// foreground knob; off is a transparent track with a hairline edge and a
		// secondary knob. The edge is drawn in both states so the track's
		// outline never moves when it switches.
		let stroke = tokens.stroke(StrokeStep::Hairline);
		let track_w = px(26.0);
		let track_h = px(16.0);
		let knob = px(12.0);
		let radius = tokens.radius(RadiusStep::Full);
		let inset = tokens.spacing(SpacingStep::S1) - stroke;

		let (track_bg, edge, knob_bg) = if self.checked {
			(
				tokens.color(ColorRole::Accent),
				tokens.color(ColorRole::Accent),
				tokens.color(ColorRole::Foreground),
			)
		} else {
			(
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Secondary),
			)
		};
		let disabled = self.state == InteractiveState::Disabled;
		let cursor = if disabled {
			CursorStyle::OperationNotAllowed
		} else {
			CursorStyle::PointingHand
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("toggle"));
		let mut track = div()
			.id(id)
			.w(track_w)
			.h(track_h)
			.flex_shrink_0()
			.rounded(radius)
			.bg(track_bg)
			.border(stroke)
			.border_color(edge)
			.px(inset)
			.flex()
			.items_center()
			.cursor(cursor)
			.child(div().size(knob).rounded(radius).bg(knob_bg));

		if self.checked {
			track = track.justify_end();
		} else {
			track = track.justify_start();
		}

		if disabled {
			track = track.opacity(0.4);
		} else if let Some(handler) = self.on_toggle {
			let next_state = !self.checked;
			track = track.on_click(move |_, window, cx| handler(next_state, window, cx));
		}

		track
	}
}
