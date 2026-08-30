//! What a session has to say, as data.
//!
//! The Rust mirror of `packages/wire/src/presentation`: view-models down,
//! [`UiEvent`]s up, and nothing that depends on the agent runtime, a terminal
//! or a browser. The drift test compares this module's variant space against
//! the TypeScript tables at run time, so a member added on either side turns it
//! red naming the member.

pub mod composer;
pub mod events;
pub mod frame;
pub mod overlay;
pub mod status;
pub mod terminal;
pub mod transcript;
pub mod workspace;

pub use composer::{CompletionCandidate, CompletionState, ComposerMode, ComposerState};
pub use events::UiEvent;
pub use frame::{Frame, Hud, HudAgent};
pub use overlay::{DialogResult, DialogViewModel, OverlayAnchor, OverlayViewModel, SelectOption};
pub use status::{ContextGauge, SessionActivity, SessionCost, StatusLineState, StatusNotice};
pub use terminal::{TerminalPanel, TerminalTab};
pub use transcript::{
	AssistantSegment, Attachment, AttachmentKind, BlockId, Level, OmittedReason, ToolStatus,
	TranscriptBlock, TurnStopReason, TurnUsage,
};
pub use workspace::{Project, Thread, ThreadState, Workspace};
