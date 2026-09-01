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

pub mod cards;
pub mod composer;
pub mod drawer;
pub mod fixture;
pub mod intent;
pub mod model;
pub mod panel;
pub mod queue;
pub mod shell;
pub mod tokens;
pub mod transcript;

pub use intent::Intent;
pub use model::*;
pub use shell::ShellView;
pub use tokens::{InstalledTokens, install_tokens};
