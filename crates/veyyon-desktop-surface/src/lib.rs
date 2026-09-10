//! The veyyon desktop surfaces (§5).
//!
//! One crate per layer: `veyyon-desktop-tokens` states the values,
//! `veyyon-desktop-kit` turns them into primitives, and this crate composes the
//! primitives into the surfaces an operator actually looks at — the queue rail,
//! the session surface, the composer, the run bar and the right panel — under a
//! shell that decides only where each region goes.
//!
//! Nothing here holds a connection. A surface is a function of a `ShellState`,
//! so the whole window renders from a fixture with no host attached, which is
//! what makes it reviewable as a picture before any transport exists.

pub mod attach;
pub mod cards;
pub mod composer;
pub mod controls;
pub mod damage;
pub mod diff;
pub mod drawer;
pub mod fixture;
pub mod intent;
pub mod keymap;
pub mod layout;
pub mod model;
pub mod navigation;
pub mod overlay;
pub mod palette;
pub mod panel;
pub mod queue;
pub mod right_panel;
pub mod settings;
pub mod shell;
pub mod terminal;
pub mod text;
pub mod tokens;
pub mod tool_view;
pub mod transcript;
pub use composer::{
	Attachment, AttachmentSource, MediaKind, MediaType, ModelChoice, Payload, PrimaryAction,
	QueueMode, SecondaryAction, ThinkingLevel, TurnPhase,
};
pub use drawer::{DrawerContent, DrawerFailure, DrawerTab, ProcessRow};
pub use intent::{Intent, IntentDiscriminants};
pub use keymap::*;
pub use model::*;
pub use overlay::*;
pub use palette::{PaletteItem, PaletteItemKind, PaletteMode};
pub use right_panel::*;
pub use settings::SettingsPage;
pub use shell::{
	HostShape, ScrollAnchor, SessionShape, ShellView,
	fields::{FieldKey, FieldSlots},
};
pub use terminal::Cell;
pub use text::{plain_line, plain_lines};
pub use tokens::{InstalledTokens, install_tokens};
pub use tool_view::{
	DisclosureCallback, TargetCallback, ToolViewCallbacks, ToolViewTarget, render_framed_block,
	render_headed_block, render_line, render_notice, render_section, render_span, render_status_row,
	render_text_block, render_tool_view, sanitize_control_sequences,
};
