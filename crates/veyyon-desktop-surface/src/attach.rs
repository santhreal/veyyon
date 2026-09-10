//! Connection attach and authentication screens (§4.4, §5.9, §8.12).
//!
//! A phase with no loaded shell behind it takes the whole surface, in place of
//! the workspace columns:
//! - Detached: disconnected prompt with an explicit attach button
//! - Connecting: attempt indicator
//! - Syncing: initial snapshot progress, determinate when the host declared a
//!   total and indeterminate when it did not
//! - `NeedsSecret`: provider authentication secret input
//! - `AwaitingExternalUrl`: browser OAuth URL prompt with external link action
//!
//! `Reconnecting` and `Fatal` draw no screen here. Both arrive over a shell
//! that already loaded, so the cached queue and transcript stay on screen and
//! the banner under the titlebar carries the message and the single recovery
//! action ([`ConnectionSurface`]).

use serde::{Deserialize, Serialize};
use veyyon_desktop_kit::{
	ButtonVariant, ColorRole, Dialog, DialogButtonSpec, Meter, SpacingStep, Spinner, SpinnerSize,
	TextField, TextRamp, TokenSet, input::Editor,
};
use veyyon_gpui::{
	AnyElement, App, ClickEvent, Context, Div, ElementId, Entity, InteractiveElement, IntoElement,
	ParentElement, Styled, Window, div, px,
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

/// Where a phase draws its message and its recovery action (§8.12).
///
/// A phase is answered in exactly one place. A transport failure over a shell
/// that already loaded states itself in the banner and leaves the cached
/// queue and transcript reachable; a phase with nothing behind it yet takes
/// the whole surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionSurface {
	/// No connection chrome: the attached product draws itself.
	Silent,
	/// A persistent banner beneath the titlebar, over the cached shell.
	Banner,
	/// A full-surface dialog in place of the workspace columns.
	Dialog,
}

impl ConnectionPhase {
	/// Returns true if the shell is fully attached and operational.
	#[must_use]
	pub const fn is_attached(&self) -> bool {
		matches!(self, Self::Attached)
	}

	/// Where this phase's message and recovery action are drawn (§8.12).
	#[must_use]
	pub const fn surface(&self) -> ConnectionSurface {
		match self {
			Self::Attached => ConnectionSurface::Silent,
			Self::Reconnecting { .. } | Self::Fatal { .. } => ConnectionSurface::Banner,
			Self::Detached
			| Self::Connecting { .. }
			| Self::Syncing { .. }
			| Self::NeedsSecret { .. }
			| Self::AwaitingExternalUrl { .. } => ConnectionSurface::Dialog,
		}
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
	cx.listener(|view, _event: &ClickEvent, _window, cx| {
		view.dispatch(Intent::RetryConnection, cx);
	})
}

/// The click that abandons the auth flow in progress.
fn cancel_auth(cx: &Context<ShellView>) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
	cx.listener(|view, _event: &ClickEvent, _window, cx| {
		view.dispatch(Intent::CancelAuthFlow, cx);
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

/// The snapshot progress indicator: a determinate bar over a declared total,
/// an indeterminate indicator when the host declared none (§8.12).
fn sync_progress(received: u32, expected: Option<u32>) -> AnyElement {
	match expected {
		Some(total) if total > 0 => {
			Meter::new(received.min(total) as f32 / total as f32).into_any_element()
		},
		_ => Spinner::new().size(SpinnerSize::Small).into_any_element(),
	}
}

/// Renders the full-surface attach or authentication screen, or `None` for a
/// phase the shell answers elsewhere (§5.9, §8.12).
///
/// Every dialog phase is one dialog: a title, a body and an action row, so the
/// operator finds the action in the same place whatever the transport is
/// doing. A waiting phase has no action; an authentication phase has its
/// step and a cancel. A phase whose surface is [`ConnectionSurface::Banner`]
/// draws no dialog, because the banner already carries both the message and
/// the recovery action.
pub fn render_attach_screen(
	phase: &ConnectionPhase,
	secret: Option<Entity<Editor>>,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Option<AnyElement> {
	if phase.surface() != ConnectionSurface::Dialog {
		return None;
	}

	let container = div()
		.id(ElementId::Name(format!("attach-screen-{}", phase.scene_slug()).into()))
		.size_full()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.bg(tokens.color(ColorRole::Ground))
		.p(tokens.spacing(SpacingStep::S8));

	// One id for the card whichever phase drew it: gpui keys element state by
	// the id path, and the phase is already in the slug.
	let dialog_id = ElementId::Name(format!("attach-{}", phase.scene_slug()).into());
	let dialog = match phase {
		ConnectionPhase::Detached => Dialog::new(
			dialog_id,
			"Disconnected from Host",
			line("No active connection to the veyyon host engine.", ColorRole::Muted, tokens),
		)
		.action_on_click(DialogButtonSpec::new("Attach", ButtonVariant::Primary), retry(cx)),
		ConnectionPhase::Connecting { attempt } => Dialog::new(
			dialog_id,
			format!("Connecting (attempt {attempt})..."),
			line("Establishing communication with the host socket.", ColorRole::Muted, tokens),
		),
		ConnectionPhase::Syncing { received, expected } => {
			let status = match expected {
				Some(total) => format!("Received {received} of {total} initial snapshots..."),
				None => format!("Received {received} snapshots..."),
			};
			let body = div()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(line(status, ColorRole::Muted, tokens))
				.child(sync_progress(*received, *expected));
			Dialog::new(dialog_id, "Synchronizing Session State", body)
		},
		// The guard above admits the dialog phases alone: the attached
		// product and the two banner phases reach here only if
		// `ConnectionPhase::surface` and this match disagree.
		ConnectionPhase::Attached
		| ConnectionPhase::Reconnecting { .. }
		| ConnectionPhase::Fatal { .. } => return None,
		ConnectionPhase::NeedsSecret { provider } => {
			// The field is the retained editor or there is no field: an
			// element built from a value carries no keystroke, so a submit
			// that read one back would send an empty secret (§8.25, §9.3).
			let body = div()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(line(
					"Enter API key or secret token to complete authentication.",
					ColorRole::Muted,
					tokens,
				))
				.children(secret.map(|editor| TextField::new("secret-key-field", editor)));
			Dialog::new(dialog_id, format!("Authenticate {provider}"), body)
				.action_on_click(
					DialogButtonSpec::new("Submit", ButtonVariant::Primary),
					cx.listener(move |view, _event: &ClickEvent, _window, cx| {
						view.submit_pending_secret(cx);
					}),
				)
				.action_on_click(DialogButtonSpec::new("Cancel", ButtonVariant::Ghost), cancel_auth(cx))
		},
		ConnectionPhase::AwaitingExternalUrl { provider, url } => {
			let target_url = url.clone();
			Dialog::new(
				dialog_id,
				format!("Authorize {provider}"),
				line("Complete OAuth authorization in your web browser.", ColorRole::Muted, tokens),
			)
			.action_on_click(
				DialogButtonSpec::new("Open in Browser", ButtonVariant::Primary),
				cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::OpenAuthUrl(target_url.clone()), cx);
				}),
			)
			.action_on_click(DialogButtonSpec::new("Cancel", ButtonVariant::Ghost), cancel_auth(cx))
		},
	};

	Some(
		container
			.child(div().w(px(CARD_WIDTH_PX)).child(dialog))
			.into_any_element(),
	)
}
