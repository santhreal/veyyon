//! Text primitives group (§8.25).

pub mod code_block;
pub mod inline;
pub mod kbd;
pub mod markdown;
pub mod text_element;
pub mod truncate;

pub use code_block::*;
pub use inline::*;
pub use kbd::*;
pub use markdown::*;
pub use text_element::*;
pub use truncate::*;
