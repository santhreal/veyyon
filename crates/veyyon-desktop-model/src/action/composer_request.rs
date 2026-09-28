//! The requests the composer sends so an extension reads its draft and
//! offers completions for it.

use serde::{Deserialize, Serialize};

use crate::{action_kind::HostActionKind, connection::SessionId};

/// The requests the composer sends on behalf of a session's extensions, each
/// tagged as the wire names it.
///
/// A family of its own rather than more variants of `HostAction`; the variant
/// that holds it is `untagged`, so a window still sends
/// `{"CompleteComposer": {…}}` and the host still reads one flat action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum ComposerRequest {
	/// States the session's draft and the caret in it, so an extension that
	/// reads the editor text reads it and a paste it makes lands at the caret.
	///
	/// `cursor` is a UTF-8 byte offset into `text`. `applied_edit` is the
	/// `seq` of the last `ComposerEdit` the composer applied, or `0` before
	/// any. The host keeps a report only when it covers every edit the host
	/// has made, so a draft read before an edit landed never overwrites the
	/// edit. The composer reports whenever the draft or the caret changes.
	ReportComposerDraft {
		session:      SessionId,
		text:         String,
		cursor:       u32,
		applied_edit: u64,
	},
	/// Asks the session's extension completion sources what completes the
	/// draft at `cursor`, a UTF-8 byte offset into `text`.
	///
	/// `query` rises with every request the composer sends. The host answers
	/// with a `ComposerCompletions` section carrying it, drops the answer to
	/// a query a newer one superseded, and answers an empty list when a
	/// source fails or does not answer in time.
	CompleteComposer { session: SessionId, query: u64, text: String, cursor: u32 },
}

impl ComposerRequest {
	/// Resolves the discriminant kind for this request.
	#[must_use]
	pub const fn kind(&self) -> HostActionKind {
		match self {
			Self::ReportComposerDraft { .. } => HostActionKind::ReportComposerDraft,
			Self::CompleteComposer { .. } => HostActionKind::CompleteComposer,
		}
	}
}
