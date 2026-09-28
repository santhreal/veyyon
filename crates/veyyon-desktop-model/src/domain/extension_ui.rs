//! What an extension puts around a session's composer: the status entries,
//! the working message, the text widgets, the edits it makes to the draft,
//! the completions it offers and the notices it raises.
//!
//! The terminal draws each of these in its own chrome. The host holds them
//! per session and states them in the sections below, so the window draws
//! the same things in the run bar, above and below the composer and in the
//! announcement stack.

use serde::{Deserialize, Serialize};

use super::Domains;
use crate::connection::SessionId;

/// Where a widget sits relative to the composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
pub enum ExtensionWidgetPlacement {
	/// Above the composer, which is where a widget goes when its extension
	/// names no placement.
	AboveEditor,
	/// Below the composer.
	BelowEditor,
}

/// One status entry an extension set, drawn in the run bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionStatusView {
	/// The key the extension set it under; setting the key again replaces it.
	pub key:  String,
	/// The text to draw, with terminal styling already stripped.
	pub text: String,
}

/// One text widget an extension set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionWidgetView {
	/// The key the extension set it under; setting the key again replaces it.
	pub key:       String,
	pub placement: ExtensionWidgetPlacement,
	/// The lines to draw, at most the ten the terminal draws.
	pub lines:     Vec<String>,
	/// Whether the extension set more lines than `lines` holds, which the
	/// window states under the last one.
	pub truncated: bool,
}

/// Everything the extensions of one session draw around its composer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionUiView {
	/// The status entries, ordered by key.
	pub statuses:        Vec<ExtensionStatusView>,
	/// The message the run bar states while a turn streams, or `None` for the
	/// window's own.
	pub working_message: Option<String>,
	/// The widgets, in the order they were last set.
	pub widgets:         Vec<ExtensionWidgetView>,
	/// Whether an extension added a completion source, so the composer asks
	/// the host for completions through `CompleteComposer`.
	pub completes:       bool,
}

/// How an extension edit changes the draft.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, strum::EnumIter,
)]
pub enum ComposerEditKind {
	/// Replaces the whole draft.
	Set,
	/// Inserts at the caret, the way a paste does.
	Paste,
}

/// One edit an extension made to a session's draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ComposerEditView {
	/// The host's number for the edit, rising with every edit it makes. A
	/// `ReportComposerDraft` states the last one the composer applied.
	pub seq:  u64,
	pub kind: ComposerEditKind,
	pub text: String,
}

/// Queues `edit` behind the edits `queue` holds for one session.
///
/// A `Set` replaces the draft, so every edit queued before it is moot and
/// the queue restarts at it. Two pastes applied back to back land at one
/// caret, so a paste after a paste joins it and takes the later number. The
/// queue therefore holds at most a `Set` followed by a `Paste`, however many
/// edits an extension makes while the session is not shown.
pub fn queue_composer_edit(queue: &mut Vec<ComposerEditView>, edit: ComposerEditView) {
	match edit.kind {
		ComposerEditKind::Set => {
			queue.clear();
			queue.push(edit);
		},
		ComposerEditKind::Paste => match queue.last_mut() {
			Some(last) if last.kind == ComposerEditKind::Paste => {
				last.text.push_str(&edit.text);
				last.seq = edit.seq;
			},
			_ => queue.push(edit),
		},
	}
}

impl Domains {
	/// Takes the edits queued for `session`'s draft, oldest first, leaving
	/// none queued. The session's composer calls this when it shows the
	/// session and whenever a `ComposerEdit` for it arrives.
	pub fn take_composer_edits(&mut self, session: &SessionId) -> Vec<ComposerEditView> {
		self.composer_edits.remove(session).unwrap_or_default()
	}
}

/// One completion an extension offered for the draft.
///
/// Offsets are UTF-8 byte offsets into the draft the `CompleteComposer`
/// carried. Accepting the completion replaces `replace_start..replace_end`
/// with `insert` and puts the caret at `caret`, an offset into the draft
/// after that replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ComposerCompletionView {
	pub label:         String,
	pub description:   Option<String>,
	pub replace_start: u32,
	pub replace_end:   u32,
	pub insert:        String,
	pub caret:         u32,
}

/// The completions the host answered one `CompleteComposer` with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ComposerCompletionsView {
	/// The `query` of the `CompleteComposer` this answers. The store keeps
	/// the answer to the newest query, so a slow answer to an earlier one
	/// never replaces it.
	pub query: u64,
	pub items: Vec<ComposerCompletionView>,
}

/// How much an extension notice interrupts, as the extension stated it.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, strum::EnumIter,
)]
pub enum ExtensionNoticeLevel {
	Info,
	Warning,
	Error,
}

/// A notice an extension raised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionNoticeView {
	pub level:        ExtensionNoticeLevel,
	pub message:      String,
	/// Epoch milliseconds the host received the notice.
	pub raised_at_ms: u64,
}
