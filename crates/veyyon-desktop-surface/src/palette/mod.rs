//! Command palette surface (§5.8).
//!
//! A floating glass surface providing fuzzy-searchable commands, sessions,
//! files, content search, and project directory browsing.

pub mod commands;
pub mod host_commands;
mod interaction;
pub mod matcher;
pub mod modes;
pub mod motion;
mod rank;
mod render;
pub mod rows;
pub mod state;

pub use self::{
	commands::command_takes_argument,
	host_commands::{HostCommands, host_commands},
	matcher::*,
	modes::*,
	render::*,
	rows::*,
	state::*,
};
