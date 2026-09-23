//! Inactive and transitional share card views (§5).

use veyyon_desktop_kit::{ButtonVariant, ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_model::{SharePhase, SurfaceId};
use veyyon_desktop_tokens::ShareSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, InteractiveElement, IntoElement, ParentElement, Styled, div,
};

use super::{ShareState, gated_control};
use crate::{Intent, ShellView, controls::ControlStates};

/// Whether this state offers controls to start sharing.
#[must_use]
pub fn offers_start(state: &ShareState) -> bool {
	state.phase() == SharePhase::Off && has_relay(state)
}

/// Whether this state offers controls to stop sharing.
#[must_use]
pub fn offers_stop(state: &ShareState) -> bool {
	state.phase() == SharePhase::Hosting
}

/// Whether a relay URL is configured.
#[must_use]
pub fn has_relay(state: &ShareState) -> bool {
	state.relay_url().is_some_and(|url| !url.trim().is_empty())
}

/// Renders the inactive share card view.
pub fn render_off_view(
	state: &ShareState,
	controls: &ControlStates,
	_geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	if !has_relay(state) {
		return div()
			.id("share-no-relay")
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child("No relay configured."),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child("Configure collab.relayUrl in settings to enable sharing."),
			)
			.into_any_element();
	}

	div()
		.id("share-off-controls")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child("Share this session with guests over the configured relay."),
		)
		.child(
			div()
				.flex()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(gated_control(
					"share-start",
					"Start sharing",
					SurfaceId::ShareStartButton,
					Intent::StartShare { read_only: false },
					ButtonVariant::Primary,
					controls,
					tokens,
					cx,
				))
				.child(gated_control(
					"share-start-readonly",
					"Start sharing (read-only)",
					SurfaceId::ShareStartReadOnlyButton,
					Intent::StartShare { read_only: true },
					ButtonVariant::Ghost,
					controls,
					tokens,
					cx,
				)),
		)
		.into_any_element()
}

/// Renders in-progress phase transitions (starting and stopping).
pub fn render_transition_view(phase: SharePhase, tokens: &TokenSet) -> AnyElement {
	let message = match phase {
		SharePhase::Starting => "Starting share…",
		SharePhase::Stopping => "Stopping share…",
		_ => "Transitioning…",
	};

	div()
		.id("share-transition")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(message),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("Waiting for the relay to answer."),
		)
		.into_any_element()
}

/// Renders unknown phase words without claiming anything.
pub fn render_unknown_view(state: &ShareState, tokens: &TokenSet) -> AnyElement {
	let raw = state.share.as_ref().map_or("unknown", |s| s.state.as_str());

	div()
		.id("share-unknown")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(format!("Relay state: {raw}")),
		)
		.into_any_element()
}
