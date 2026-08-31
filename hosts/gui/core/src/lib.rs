//! Toolkit-free desktop state and the single typed host boundary.
//!
//! Crate direction is `core <- kit <- features <- app`. This crate performs no
//! I/O and imports no UI toolkit. Production starts detached and empty; host
//! events are the only source of product replica values.

pub mod command;
pub mod host;
pub mod keys;
pub mod model;
pub mod navigation;
pub mod palette;
pub mod store;
pub mod text;
pub mod theme;

pub use command::{CommandClass, UiCommand};
pub use host::{HostAction, HostEvent, HostRequest, SnapshotSection};
pub use store::{Changes, Effects, ShellEffect, Store};
