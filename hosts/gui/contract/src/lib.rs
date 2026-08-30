//! The contracts this host draws against, in Rust.
//!
//! A host is the member that draws. It consumes contracts and is named by
//! nothing that produces them, which is what lets the terminal host and this
//! one draw the same session without either knowing the other exists. This
//! crate is the Rust side of the three contracts a host needs, plus the seam a
//! transport implements:
//!
//! - [`session`] — what a session has to say. The mirror of
//!   `packages/wire/src/presentation`: view-models down, [`session::UiEvent`]s
//!   up, nothing that depends on the agent runtime.
//! - [`view`] — what a tool result looks like, as data. The set
//!   `packages/tool-render/src/parts.tsx` already draws, so a tone or a badge
//!   set on this side is the one the terminal host draws.
//! - [`host`] — what the surface being drawn on can do. A session degrades
//!   against what it is told rather than what it assumes.
//! - [`screen`] — the shape of each screen a window can open, and the
//!   [`screen::Route`] map over them. Provisional: nothing in TypeScript
//!   describes a screen yet.
//! - [`source`] — the one trait between a window and its data, so a window is
//!   drawn from fixtures, a transport or a recording without any of the three
//!   being a special case.
//!
//! There is no gpui here, and there will not be. Every type in this crate
//! builds and asserts without a window, which is why a layout question is
//! answered by a test rather than by a screenshot.
//!
//! # The mirror is checked, not trusted
//!
//! A hand-written mirror drifts. `tests/` compares [`session`]'s variant space
//! against the TypeScript tables (`TRANSCRIPT_BLOCK_KINDS`, `DIALOG_KINDS`,
//! `UI_EVENT_TYPES`) at run time, so a member added on either side turns the
//! test red naming the member. The Rust side of that comparison comes from
//! serde rather than from a list somebody maintains — see [`reflect`].
//!
//! [`view`] has no such check yet, and the reason is worth stating: the
//! TypeScript side is React components rather than a data model, so there is no
//! table to enumerate. [`view::ViewKind::ALL`] is checked against the fixtures,
//! which catches a kind nobody draws and catches nothing about the TypeScript.
//!
//! # What is deliberately not mirrored
//!
//! - **`PresentationContext`.** Its methods are calls, not data. They arrive
//!   over the transport as messages, and a Rust trait with the same signatures
//!   would describe nothing that exists on this side.
//! - **`PresentationTheme`.** This host reads veyyon's theme files directly,
//!   through `veyyon-gui-theme`, and derives the surfaces a window needs.
//!   Mirroring the terminal's flattened palette would give the GUI a second
//!   theme path with fewer colours in it.

pub mod fixtures;
pub mod host;
pub mod reflect;
pub mod screen;
pub mod session;
pub mod source;
pub mod view;

pub use host::PresentationCapabilities;
pub use screen::{Route, RouteId};
pub use session::{
	AssistantSegment, Attachment, AttachmentKind, BlockId, CompletionCandidate, CompletionState,
	ComposerMode, ComposerState, ContextGauge, DialogResult, DialogViewModel, Frame, Hud, HudAgent,
	Level, OmittedReason, OverlayAnchor, OverlayViewModel, SelectOption, SessionActivity,
	SessionCost, StatusLineState, StatusNotice, ToolStatus, TranscriptBlock, TurnStopReason,
	TurnUsage, UiEvent,
};
pub use source::Source;
pub use view::{Badge, Tone, View, ViewKind};
