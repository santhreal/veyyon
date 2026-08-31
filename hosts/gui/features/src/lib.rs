//! The surfaces, and the renderers that fill them.
//!
//! One directory per surface, one file per block kind a transcript can carry.
//! Nothing here names the window: a surface is a function of the store and this
//! frame's instant, and it returns elements. What a press does travels the
//! other way, as a [`UiCommand`](veyyon_gui_core::UiCommand) dispatched through
//! [`act`], so a surface holds no handle on the view it is drawn in.
//!
//! That is what makes a surface movable, and what keeps the window from
//! becoming the file every feature has to be edited in.
//!
//! A SURFACE'S SHAPE. `<surface>/mod.rs` says what it is and re-exports,
//! `view.rs` draws, `logic.rs` is the part that can be decided without a
//! window, and `tests.rs` proves the logic. A surface with no decisions of its
//! own has no `logic.rs`.

pub mod act;
pub mod agents;
pub mod changes;
pub mod composer;
pub mod conversation;
pub mod extensions;
pub mod files;
pub mod inspector;
pub mod mcp;
pub mod models;
pub mod overlays;
pub mod palette;
pub mod problems;
pub mod providers;
pub mod render;
pub mod settings;
pub mod shell;
pub mod tasks;
pub mod terminal;
pub mod transcript;
