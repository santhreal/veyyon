//! Unified diff parsing and intraline alignment (§5.11).

pub mod intraline;
pub mod parse;

pub use intraline::pair_intraline;
pub use parse::{CHANGED_ROWS_CAP, parse_diff};
