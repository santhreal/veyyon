//! Connection attach and authentication screens (§4.4, §5.9, §8.12).
//!
//! When the transport is not attached, the shell renders one of six dedicated
//! attach/auth screens in place of the main workspace columns:
//! - Detached: disconnected prompt with an explicit attach button
//! - Connecting: attempt indicator and spinner
//! - Syncing: initial snapshot synchronization progress
//! - Reconnecting: countdown timer, failure reason, and retry action
//! - Fatal: unrecoverable protocol error with failure explanation
//! - `NeedsSecret`: provider authentication secret input
//! - `AwaitingExternalUrl`: browser OAuth URL prompt with external link action

use serde::{Deserialize, Serialize};
use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, RadiusStep, SpacingStep, StrokeStep, TextField,
	TextRamp, TokenSet,
};
use veyyon_gpui::{
	ClickEvent, Div, ElementId, InteractiveElement, IntoElement, ParentElement, Styled, div,
};

use crate::{Intent, ShellView};

/// Active transport connectivity phase or authentication overlay state (§5.9,
/// §8.12).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ConnectionPhase {
	/// Transport is disconnected.
	#[default]
	Detached,
	/// Active socket connection attempt in progress.
	Connecting {
		/// Monotonically increasing attempt counter.
		attempt: u32,
	},
	/// Ingesting initial capability and session snapshots.
	Syncing {
		/// Count of received snapshot sections.
		received: u32,
		/// Expected total snapshot section count if known.
		expected: Option<u32>,
	},
	/// Fully attached and synchronized with GUI host.
	Attached,
	/// Socket connection dropped; awaiting backoff retry.
	Reconnecting {
		/// Reconnection attempt count.
		attempt:     u32,
		/// Timestamp in milliseconds when the next attempt occurs.
		retry_at_ms: u64,
		/// Reason for the socket disconnection.
		message:     String,
	},
	/// Unrecoverable failure or protocol version mismatch.
	Fatal {
		/// Detailed fatal failure description.
		message: String,
	},
	/// Provider requires secret key input.
	NeedsSecret {
		/// Provider identifier requesting authentication.
		provider: String,
	},
	/// Provider requires OAuth authorization in an external browser.
	AwaitingExternalUrl {
		/// Provider identifier requesting authorization.
		provider: String,
		/// OAuth redirect URL.
		url:      String,
	},
}

impl ConnectionPhase {
	/// Returns true if the shell is fully attached and operational.
	#[must_use]
	pub const fn is_attached(&self) -> bool {
		matches!(self, Self::Attached)
	}

	/// Returns a stable descriptor name for scene cataloguing.
	#[must_use]
	pub const fn scene_slug(&self) -> &'static str {
		match self {
			Self::Detached => "connection-detached",
			Self::Connecting { .. } => "connection-connecting",
			Self::Syncing { .. } => "connection-syncing",
			Self::Attached => "connection-connected",
			Self::Reconnecting { .. } => "connection-reconnecting",
			Self::Fatal { .. } => "connection-fatal",
			Self::NeedsSecret { .. } => "auth-needs-secret",
			Self::AwaitingExternalUrl { .. } => "auth-awaiting-external-url",
		}
	}
}

/// Renders the full-surface attach or authentication screen (§5.9, §8.12).
pub fn render_attach_screen(
	phase: &ConnectionPhase,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> impl IntoElement {
	let container = div()
		.id(ElementId::Name(format!("attach-screen-{}", phase.scene_slug()).into()))
		.size_full()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.bg(tokens.color(ColorRole::Ground))
		.p(tokens.spacing(SpacingStep::S8));

	let card_radius = tokens.radius(RadiusStep::Lg);
	let card_pad = tokens.spacing(SpacingStep::S6);
	let card_stroke = tokens.stroke(StrokeStep::Hairline);
	let border_color = tokens.color(ColorRole::Hairline);
	let card_bg = tokens.color(ColorRole::Canvas);

	let card = div()
		.flex()
		.flex_col()
		.items_center()
		.w(veyyon_gpui::px(420.0))
		.p(card_pad)
		.rounded(card_radius)
		.bg(card_bg)
		.border(card_stroke)
		.border_color(border_color)
		.gap(tokens.spacing(SpacingStep::S4));

	let content = match phase {
		ConnectionPhase::Detached => render_detached_card(card, tokens, cx),
		ConnectionPhase::Connecting { attempt } => render_connecting_card(card, *attempt, tokens),
		ConnectionPhase::Syncing { received, expected } => {
			render_syncing_card(card, *received, *expected, tokens)
		},
		ConnectionPhase::Attached => card,
		ConnectionPhase::Reconnecting { attempt, message, .. } => {
			render_reconnecting_card(card, *attempt, message, tokens, cx)
		},
		ConnectionPhase::Fatal { message } => render_fatal_card(card, message, tokens, cx),
		ConnectionPhase::NeedsSecret { provider } => {
			render_needs_secret_card(card, provider, tokens, cx)
		},
		ConnectionPhase::AwaitingExternalUrl { provider, url } => {
			render_awaiting_url_card(card, provider, url, tokens, cx)
		},
	};
	container.child(content)
}
fn render_detached_card(card: Div, tokens: &TokenSet, cx: &veyyon_gpui::Context<ShellView>) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Foreground))
		.child("Disconnected from Host");

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child("No active connection to the veyyon host engine.");

	let attach_btn = Button::new("Attach")
		.id("attach-btn")
		.variant(ButtonVariant::Primary)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::RetryConnection);
		}));

	card.child(title).child(desc).child(attach_btn)
}

fn render_connecting_card(card: Div, attempt: u32, tokens: &TokenSet) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Foreground))
		.child(format!("Connecting (attempt {attempt})..."));

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child("Establishing communication with the host socket.");

	card.child(title).child(desc)
}

fn render_syncing_card(card: Div, received: u32, expected: Option<u32>, tokens: &TokenSet) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Foreground))
		.child("Synchronizing Session State");

	let status = match expected {
		Some(total) => format!("Received {received} of {total} initial snapshots..."),
		None => format!("Received {received} snapshots..."),
	};

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child(status);

	card.child(title).child(desc)
}

fn render_reconnecting_card(
	card: Div,
	attempt: u32,
	message: &str,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Accent))
		.child(format!("Reconnecting (attempt {attempt})..."));

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string());

	let retry_btn = Button::new("Retry Now")
		.id("retry-btn")
		.variant(ButtonVariant::Primary)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::RetryConnection);
		}));

	card.child(title).child(desc).child(retry_btn)
}

fn render_fatal_card(
	card: Div,
	message: &str,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::ErrorInk))
		.child("Connection Error");

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string());

	let retry_btn = Button::new("Re-attach")
		.id("reattach-btn")
		.variant(ButtonVariant::Danger)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::RetryConnection);
		}));

	card.child(title).child(desc).child(retry_btn)
}

fn render_needs_secret_card(
	card: Div,
	provider: &str,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Foreground))
		.child(format!("Authenticate {provider}"));

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child("Enter API key or secret token to complete authentication.");

	let input = TextField::new("secret-key-field").placeholder("API Key / Token");

	let prov = provider.to_string();
	let submit_btn = Button::new("Submit")
		.id("submit-secret-btn")
		.variant(ButtonVariant::Primary)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
			view
				.dispatch(Intent::SubmitAuthSecret { provider: prov.clone(), secret: String::new() });
		}));

	let cancel_btn = Button::new("Cancel")
		.id("cancel-auth-btn")
		.variant(ButtonVariant::Ghost)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::CancelAuthFlow);
		}));

	let actions = div()
		.flex()
		.flex_row()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(submit_btn)
		.child(cancel_btn);

	card.child(title).child(desc).child(input).child(actions)
}

fn render_awaiting_url_card(
	card: Div,
	provider: &str,
	url: &str,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Div {
	let title = div()
		.text_size(tokens.font_size(TextRamp::Head))
		.line_height(tokens.line_height(TextRamp::Head))
		.text_color(tokens.color(ColorRole::Foreground))
		.child(format!("Authorize {provider}"));

	let desc = div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ColorRole::Muted))
		.child("Complete OAuth authorization in your web browser.");

	let target_url = url.to_string();
	let open_btn = Button::new("Open in Browser")
		.id("open-auth-url-btn")
		.variant(ButtonVariant::Primary)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::OpenAuthUrl(target_url.clone()));
		}));

	let cancel_btn = Button::new("Cancel")
		.id("cancel-auth-url-btn")
		.variant(ButtonVariant::Ghost)
		.size(ButtonSize::Medium)
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
			view.dispatch(Intent::CancelAuthFlow);
		}));

	let actions = div()
		.flex()
		.flex_row()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(open_btn)
		.child(cancel_btn);

	card.child(title).child(desc).child(actions)
}
