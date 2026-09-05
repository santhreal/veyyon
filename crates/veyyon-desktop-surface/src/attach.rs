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
	ButtonVariant, ColorRole, Dialog, DialogButtonSpec, SpacingStep, TextField, TextRamp, TokenSet,
};
use veyyon_gpui::{
	App, ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	Styled, Window, div, px,
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

/// The width every attach card draws at: one measure, so the screens read as
/// one surface changing state rather than six.
const CARD_WIDTH_PX: f32 = 420.0;

/// The click that asks the host to attach again.
fn retry(cx: &Context<ShellView>) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
	cx.listener(|view, _event: &ClickEvent, _window, _cx| {
		view.dispatch(Intent::RetryConnection);
	})
}

/// The click that abandons the auth flow in progress.
fn cancel_auth(cx: &Context<ShellView>) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
	cx.listener(|view, _event: &ClickEvent, _window, _cx| {
		view.dispatch(Intent::CancelAuthFlow);
	})
}

/// One line of body copy in the read ramp, in `ink`.
fn line(text: impl Into<String>, ink: ColorRole, tokens: &TokenSet) -> Div {
	div()
		.text_size(tokens.font_size(TextRamp::Read))
		.line_height(tokens.line_height(TextRamp::Read))
		.text_color(tokens.color(ink))
		.child(text.into())
}

/// Renders the full-surface attach or authentication screen (§5.9, §8.12).
///
/// Every phase is one dialog: a title, a body and an action row, so the
/// operator finds the action in the same place whatever the transport is
/// doing. A waiting phase has no action; an authentication phase has its
/// step and a cancel.
pub fn render_attach_screen(
	phase: &ConnectionPhase,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
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

	let dialog = match phase {
		ConnectionPhase::Detached => Dialog::new(
			"Disconnected from Host",
			line("No active connection to the veyyon host engine.", ColorRole::Muted, tokens),
		)
		.action_on_click(DialogButtonSpec::new("Attach", ButtonVariant::Primary), retry(cx)),
		ConnectionPhase::Connecting { attempt } => Dialog::new(
			format!("Connecting (attempt {attempt})..."),
			line("Establishing communication with the host socket.", ColorRole::Muted, tokens),
		),
		ConnectionPhase::Syncing { received, expected } => {
			let status = match expected {
				Some(total) => format!("Received {received} of {total} initial snapshots..."),
				None => format!("Received {received} snapshots..."),
			};
			Dialog::new("Synchronizing Session State", line(status, ColorRole::Muted, tokens))
		},
		ConnectionPhase::Attached => Dialog::new("Attached", div()),
		ConnectionPhase::Reconnecting { attempt, message, .. } => Dialog::new(
			format!("Reconnecting (attempt {attempt})..."),
			line(message.clone(), ColorRole::Accent, tokens),
		)
		.action_on_click(DialogButtonSpec::new("Retry Now", ButtonVariant::Primary), retry(cx)),
		ConnectionPhase::Fatal { message } => {
			Dialog::new("Connection Error", line(message.clone(), ColorRole::ErrorInk, tokens))
				.action_on_click(DialogButtonSpec::new("Re-attach", ButtonVariant::Danger), retry(cx))
		},
		ConnectionPhase::NeedsSecret { provider } => {
			let prov = provider.clone();
			let body = div()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(line(
					"Enter API key or secret token to complete authentication.",
					ColorRole::Muted,
					tokens,
				))
				.child(TextField::new("secret-key-field").placeholder("API Key / Token"));
			Dialog::new(format!("Authenticate {provider}"), body)
				.action_on_click(
					DialogButtonSpec::new("Submit", ButtonVariant::Primary),
					cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
						view.dispatch(Intent::SubmitAuthSecret {
							provider: prov.clone(),
							secret:   String::new(),
						});
					}),
				)
				.action_on_click(DialogButtonSpec::new("Cancel", ButtonVariant::Ghost), cancel_auth(cx))
		},
		ConnectionPhase::AwaitingExternalUrl { provider, url } => {
			let target_url = url.clone();
			Dialog::new(
				format!("Authorize {provider}"),
				line("Complete OAuth authorization in your web browser.", ColorRole::Muted, tokens),
			)
			.action_on_click(
				DialogButtonSpec::new("Open in Browser", ButtonVariant::Primary),
				cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
					view.dispatch(Intent::OpenAuthUrl(target_url.clone()));
				}),
			)
			.action_on_click(DialogButtonSpec::new("Cancel", ButtonVariant::Ghost), cancel_auth(cx))
		},
	};

	container.child(
		div()
			.w(px(CARD_WIDTH_PX))
			.child(dialog.id(ElementId::Name(format!("attach-{}", phase.scene_slug()).into()))),
	)
}
