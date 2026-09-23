//! Session sharing floating overlay card (§5).
//!
//! Renders the share hosting controls, links, and relay participants.

pub mod hosting;
pub mod off;

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, InteractiveState, SpacingStep, TextRamp,
	TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_model::{SharePhase, ShareView, SurfaceId};
use veyyon_desktop_tokens::ShareSurfaceTokens;
use veyyon_gpui::{
	Context, ElementId, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style, hairline_for},
	navigation::SurfaceRoute,
};

/// View model for the session sharing overlay card.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShareState {
	pub share: Option<ShareView>,
	pub route: Option<SurfaceRoute>,
}

impl ShareState {
	#[must_use]
	pub const fn new() -> Self {
		Self { share: None, route: Some(SurfaceRoute::Share) }
	}

	#[must_use]
	pub fn phase(&self) -> SharePhase {
		self
			.share
			.as_ref()
			.map_or(SharePhase::Off, ShareView::phase)
	}

	#[must_use]
	pub fn relay_url(&self) -> Option<&str> {
		self.share.as_ref().and_then(|s| s.relay_url.as_deref())
	}

	#[must_use]
	pub fn error(&self) -> Option<&str> {
		self.share.as_ref().and_then(|s| s.error.as_deref())
	}
}

/// Renders the session sharing card surface.
pub fn share_surface(
	state: &ShareState,
	back: Option<SurfaceRoute>,
	focus: Option<&FocusHandle>,
	controls: &ControlStates,
	geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut container = div()
		.id("share-card")
		.flex()
		.flex_col()
		.w_full()
		.h_full()
		.p(px(geometry.padding));

	if let Some(f) = focus {
		container = container.track_focus(f);
	}

	let title = SurfaceRoute::Share.title();

	let mut header = div()
		.id("share-card-header")
		.flex()
		.items_center()
		.justify_between()
		.pb(tokens.spacing(SpacingStep::S4))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Head))
				.line_height(tokens.line_height(TextRamp::Head))
				.font_weight(tokens.font_weight(TextWeight::Semibold))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(title),
		);

	let mut actions = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	if let Some(back_route) = back {
		actions = actions.child(
			Button::new("share-back", "Back")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::Navigate(back_route), cx);
				})),
		);
	}

	actions = actions.child(
		Button::new("share-close", "Close")
			.size(ButtonSize::Small)
			.variant(ButtonVariant::Ghost)
			.on_click(cx.listener(|view, _, _, cx| {
				view.dispatch(Intent::CloseOverlay, cx);
			})),
	);

	header = header.child(actions);
	container = container.child(header);

	if let Some(err) = state.error() {
		let error_box = div()
			.id("share-error-banner")
			.flex()
			.items_center()
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S2))
			.mb(tokens.spacing(SpacingStep::S3))
			.bg(tokens.tint(TintRole::Error).fill)
			.text_color(tokens.tint(TintRole::Error).ink)
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.child(format!("Error: {err}"));
		container = container.child(error_box);
	}

	let phase = state.phase();
	let body = match phase {
		SharePhase::Off => {
			off::render_off_view(state, controls, geometry, tokens, cx).into_any_element()
		},
		SharePhase::Starting | SharePhase::Stopping => {
			off::render_transition_view(phase, tokens).into_any_element()
		},
		SharePhase::Hosting => {
			hosting::render_hosting_view(state, controls, geometry, tokens, cx).into_any_element()
		},
		SharePhase::Unknown => off::render_unknown_view(state, tokens).into_any_element(),
	};

	container.child(body)
}

/// A share control drawn at the availability the host projected for it, with
/// the refusal that landed on it beneath (§4.3, §4.4).
///
/// A control never decides its own availability: the press is attached only
/// where the gate allows it, and a control the host has not answered for is
/// drawn at the gate's own opacity rather than at rest. Every share control is
/// one request the host either takes or refuses, so a second press while one is
/// in flight is what this keeps from reaching the relay, and a refusal is
/// stated where the press was made rather than on the window's line.
pub fn gated_control(
	id: impl Into<ElementId>,
	label: &'static str,
	surface: SurfaceId,
	intent: Intent,
	variant: ButtonVariant,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let (opacity, _, allowed) = availability_style(&controls.availability(&surface), tokens);
	let mut button = Button::new(id, label)
		.size(ButtonSize::Medium)
		.variant(variant);
	if allowed {
		button = button.on_click(cx.listener(move |view, _, _, cx| {
			view.dispatch(intent.clone(), cx);
		}));
	} else {
		button = button.state(InteractiveState::Disabled);
	}
	let mut column = div()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(div().opacity(opacity).child(button));
	if let Some(hairline) = hairline_for(controls, &surface, tokens, cx) {
		column = column.child(hairline);
	}
	column
}
