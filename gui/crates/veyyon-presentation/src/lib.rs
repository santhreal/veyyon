//! Rust mirror of veyyon's presentation contract.
//!
//! The contract is defined once, in TypeScript, at
//! `packages/wire/src/presentation`. It is the whole interface between a
//! session and whatever draws it: view-models down, [`UiEvent`]s up, nothing
//! that depends on the agent runtime, a terminal or a browser. This crate is
//! the same shapes in Rust, with serde attributes that reproduce the JSON
//! exactly, so the GPU front end is a peer of the terminal front end rather
//! than a client of it.
//!
//! # The mirror is checked, not trusted
//!
//! A hand-written mirror drifts. `tests/` compares this crate's variant space
//! against the TypeScript tables (`TRANSCRIPT_BLOCK_KINDS`, `DIALOG_KINDS`,
//! `UI_EVENT_TYPES`) at run time, so a member added on either side turns the
//! test red naming the member. The Rust side of that comparison comes from
//! serde rather than from a list somebody maintains — see [`reflect`].
//!
//! # What is deliberately not mirrored
//!
//! - **`PresentationContext`.** Its methods are calls, not data. They arrive
//!   over the transport as messages, and a Rust trait with the same signatures
//!   would describe nothing that exists on this side.
//! - **`PresentationTheme`.** The GPU front end reads veyyon's theme files
//!   directly, through `veyyon-theme`, and derives the surfaces a window needs.
//!   Mirroring the terminal's flattened palette would give the GUI a second
//!   theme path with fewer colours in it.

pub mod capabilities;
pub mod composer;
pub mod events;
pub mod fixtures;
pub mod overlay;
pub mod reflect;
pub mod status;
pub mod transcript;

pub use capabilities::PresentationCapabilities;
pub use composer::{CompletionCandidate, CompletionState, ComposerMode, ComposerState};
pub use events::UiEvent;
pub use overlay::{DialogResult, DialogViewModel, OverlayAnchor, OverlayViewModel, SelectOption};
pub use status::{ContextGauge, SessionActivity, SessionCost, StatusLineState, StatusNotice};
pub use transcript::{
	AssistantSegment, Attachment, AttachmentKind, BlockId, Level, OmittedReason, ToolStatus,
	TranscriptBlock, TurnStopReason, TurnUsage,
};
