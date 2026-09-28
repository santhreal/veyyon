//! The rows a panel tab draws for the requests the host refused on its
//! controls.
//!
//! Each row states what was refused in the host's words, a retry only when
//! the host would take the request again, and the dismissal that forgets it.
//!
//! A refusal is read from the store's retry memory on every render rather
//! than held by a tab, so a retried or dismissed refusal is gone from the
//! next frame and one that landed while another tab was shown is stated when
//! its own tab is.

use veyyon_desktop_model::{HostAction, RequestId, SurfaceId as S};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton},
	icons::IconName,
	theme::{Palette, TypeStyled, space, text},
};
use veyyon_gpui::{AnyElement, ClickEvent, Context, Entity, Window, div, prelude::*};

use super::{PanelTab, RightPanel};
use crate::{AppState, driver};

impl RightPanel {
	/// Ends the spinner of a request the panel sent once the host answers
	/// it, and draws a refusal that landed on the shown tab's controls.
	pub(super) fn settle(&mut self, request: RequestId, ok: bool, cx: &mut Context<Self>) {
		if let Some(ix) = self.awaiting.iter().position(|awaited| *awaited == request) {
			self.awaiting.swap_remove(ix);
			cx.notify();
		}
		self.follow_refusals(!ok, cx);
	}

	/// Draws the shown tab again when the refusals it states changed: one
	/// `landed` on its controls, or an answer or a second send took one off.
	pub(super) fn follow_refusals(&self, landed: bool, cx: &mut Context<Self>) {
		let stated = count(self.app.read(cx), self.active);
		if (landed && stated > 0) || stated != self.stated {
			cx.notify();
		}
	}

	/// The shown tab's refusal rows, forgetting the driver targets of the
	/// rows the last render drew and this one does not.
	pub(super) fn refusal_rows(
		&mut self,
		palette: &Palette,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Vec<AnyElement> {
		let rows = rows(&self.app, self.active, palette, cx);
		for gone in rows.len()..self.stated {
			driver::forget(window, &format!("panel.refused:{gone}"), cx);
			driver::forget(window, &format!("panel.dismiss:{gone}"), cx);
		}
		self.stated = rows.len();
		rows
	}
}

impl PanelTab {
	/// The tab that states a refusal landed on `surface`, `None` for a
	/// control the panel does not draw. The match is exhaustive, so a control
	/// added to the vocabulary states which tab owns it before it compiles.
	#[must_use]
	pub const fn stating(surface: &S) -> Option<Self> {
		match surface {
			S::RightPanelDiffTab(_) | S::RightPanelChangeScopeSelector(_) => Some(Self::Diff),
			S::RightPanelFileTab(_) => Some(Self::Files),
			S::TaskSpawnButton
			| S::TaskCancelButton(_)
			| S::AgentReviveButton(_)
			| S::RightPanelPreviewTab(_) => Some(Self::Agents),
			S::DiagnosticRefreshButton | S::DiagnosticRetrySourceButton(_) | S::OutputClearButton => {
				Some(Self::Diagnostics)
			},
			S::UsageRefreshButton | S::ContextBreakdownRefreshButton | S::RightPanelUsageTab(_) => {
				Some(Self::Usage)
			},
			S::RightPanelSessionDetailTab(_)
			| S::ConnectionAttachButton
			| S::ConnectionDetachButton
			| S::ConnectionRetryButton
			| S::ShutdownButton
			| S::AgentsPauseButton
			| S::AgentsResumeButton
			| S::GlobalTitlebarLine
			| S::QueueSessionRow(_)
			| S::QueueParkButton(_)
			| S::QueueUnparkButton(_)
			| S::QueueDeferButton(_)
			| S::QueueRecallButton(_)
			| S::QueuePinButton(_)
			| S::QueueUnpinButton(_)
			| S::QueueDeleteButton(_)
			| S::QueueFilterInput
			| S::NewSessionButton
			| S::SessionBranchButton(_)
			| S::SessionRenameField(_)
			| S::SessionExportButton(_)
			| S::SessionCompactButton(_)
			| S::SessionHandoffButton(_)
			| S::SessionRetryButton(_)
			| S::SessionRephraseButton(_)
			| S::SessionPlanReviewButton(_)
			| S::ComposerSendButton(_)
			| S::ComposerSteerButton(_)
			| S::ComposerQueueButton(_)
			| S::ComposerAbortButton(_)
			| S::ComposerBackgroundButton(_)
			| S::ComposerModelSelector(_)
			| S::ComposerThinkingSelector(_)
			| S::ComposerQueueModeToggle(_)
			| S::ComposerQueuedTakeBack(_)
			| S::ComposerCancelToolButton(..)
			| S::ComposerGoalChip(_)
			| S::ComposerPlanChip(_)
			| S::ComposerDictateButton(_)
			| S::ComposerHistoryButton(_)
			| S::ComposerDraftReport(_)
			| S::ComposerCompletionQuery(_)
			| S::ApprovalApproveButton(..)
			| S::ApprovalDeclineButton(..)
			| S::ApprovalAlwaysAllowButton(..)
			| S::ApprovalCancelButton(..)
			| S::QuestionOptionButton(..)
			| S::QuestionSubmitButton(..)
			| S::PlanAcceptButton(..)
			| S::PlanRefineButton(..)
			| S::PlanAcceptNewSessionButton(..)
			| S::TerminalCreateButton(_)
			| S::TerminalCloseButton(..)
			| S::TerminalRestartButton(..)
			| S::TerminalClearButton(..)
			| S::ProcessStartButton(_)
			| S::ProcessStopButton(..)
			| S::ProcessRestartButton(..)
			| S::ProcessSignalButton(..)
			| S::ProcessSendButton(..)
			| S::ProcessLogsTab(..)
			| S::PaletteInput
			| S::PaletteItem(_)
			| S::SettingsField(_)
			| S::ThemeSelector
			| S::KeybindingField(_)
			| S::ProviderAuthStartButton(_)
			| S::ProviderAuthSecretSubmit(_)
			| S::ProviderAuthUrlOpen(_)
			| S::ProviderAuthCancelButton(_)
			| S::ProviderAuthRetryButton(_)
			| S::AuthRefreshButton
			| S::McpRetryButton(_)
			| S::McpEnableToggle(_)
			| S::ShareStartButton
			| S::ShareStartReadOnlyButton
			| S::ShareStopButton
			| S::ShareRefreshButton
			| S::ShareJoinButton
			| S::ShareLeaveButton
			| S::ShareLinkField
			| S::ProfileCreateButton
			| S::ProfileRenameButton(_)
			| S::ProfileDeleteButton(_)
			| S::ProfileRefreshButton
			| S::AutoswarmField(..)
			| S::AutoswarmActionButton(..)
			| S::AutoswarmPresetSaveButton(_)
			| S::AutoswarmPresetDeleteButton(_)
			| S::AutoswarmCloseButton(_) => None,
		}
	}
}

/// How many requests the host refused on controls `tab` draws.
pub fn count(app: &AppState, tab: PanelTab) -> usize {
	app.store()
		.retries
		.refused()
		.filter(|surface| PanelTab::stating(surface) == Some(tab))
		.count()
}

/// Whether the host refused `action` on a control `tab` draws, so the pane
/// that waits for its answer leaves the refusal row to state it.
pub fn refused(app: &AppState, tab: PanelTab, action: &HostAction) -> bool {
	let retries = &app.store().retries;
	retries.refused().any(|surface| {
		PanelTab::stating(surface) == Some(tab) && retries.peek(surface) == Some(action)
	})
}

/// One row per request the host refused on a control `tab` draws, each the
/// driver target `panel.refused:<n>` with its dismissal `panel.dismiss:<n>`.
pub fn rows(
	app: &Entity<AppState>,
	tab: PanelTab,
	palette: &Palette,
	cx: &Context<RightPanel>,
) -> Vec<AnyElement> {
	let retries = &app.read(cx).store().retries;
	retries
		.refused()
		.filter(|surface| PanelTab::stating(surface) == Some(tab))
		.filter_map(|surface| {
			let reason = retries.reason(surface)?;
			let copy = format!("The host refused {}: {reason}", refused_label(retries.peek(surface)));
			Some((surface.clone(), copy, retries.can_retry(surface)))
		})
		.enumerate()
		.map(|(ix, (surface, copy, retryable))| row(ix, surface, copy, retryable, app, palette, cx))
		.collect()
}

/// A refusal's row: the statement, a retry when the host takes the request
/// again, and the dismissal.
fn row(
	ix: usize,
	surface: S,
	copy: String,
	retryable: bool,
	app: &Entity<AppState>,
	palette: &Palette,
	cx: &Context<RightPanel>,
) -> AnyElement {
	let retry = retryable.then(|| {
		let (app, surface) = (app.clone(), surface.clone());
		Button::new(("panel-refused-retry", ix), "Retry")
			.size(ButtonSize::Sm)
			.variant(ButtonVariant::Ghost)
			.on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
				app.update(cx, |app, cx| app.retry_refused(&surface, cx));
				cx.notify();
			}))
	});
	let app = app.clone();
	let dismiss = IconButton::new(("panel-refused-dismiss", ix), IconName::X)
		.tooltip("Dismiss")
		.on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
			app.update(cx, |app, _| app.forget_refused(&surface));
			cx.notify();
		}));
	let row = div()
		.flex()
		.flex_none()
		.items_center()
		.gap(space::S2)
		.px(space::S3)
		.py(space::S1)
		.border_b_1()
		.border_color(palette.border.subtle)
		.type_style(text::SMALL)
		.text_color(palette.status.error)
		.child(div().flex_1().min_w_0().child(copy))
		.children(retry)
		.child(driver::target(("panel.dismiss", ix), dismiss));
	driver::target(("panel.refused", ix), row)
}

/// What a refused panel request asked for, as its row states it.
fn refused_label(action: Option<&HostAction>) -> String {
	match action {
		Some(HostAction::RefreshChanges) => "the changes".to_owned(),
		Some(HostAction::SelectChangeScope { .. }) => "the changes of that scope".to_owned(),
		Some(HostAction::LoadFileTree { .. }) => "the project tree".to_owned(),
		Some(HostAction::ReadFile { path }) => format!("reading {path}"),
		Some(HostAction::SearchFiles { query } | HostAction::SearchContent { query }) => {
			format!("the search for {query}")
		},
		Some(HostAction::OpenExternal { path }) => format!("opening {path}"),
		Some(HostAction::RefreshAgents) => "the roster".to_owned(),
		Some(HostAction::SpawnTask { .. }) => "the task".to_owned(),
		Some(HostAction::ReviveAgent { .. }) => "reviving the agent".to_owned(),
		Some(HostAction::CancelTask { .. }) => "ending the agent".to_owned(),
		Some(HostAction::PreviewSessionTranscript { .. }) => "the preview".to_owned(),
		Some(HostAction::RefreshDiagnostics) => "the diagnostics".to_owned(),
		Some(HostAction::RetryDiagnosticSource { source }) => format!("retrying {source}"),
		Some(HostAction::ClearOutput { .. }) => "clearing the output".to_owned(),
		Some(HostAction::GetUsage { .. }) => "the usage".to_owned(),
		Some(HostAction::GetContextBreakdown { .. }) => "the context window".to_owned(),
		_ => "the request".to_owned(),
	}
}
