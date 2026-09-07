//! Specialized, token-driven motion drivers for standard desktop UI
//! interactions.
//!
//! Provides stable identity, velocity-preserving interruptions, and centralized
//! reduced-motion resolution for all 7 motion roles (§7.1, §7.2, §8.23).

pub mod caret;
pub mod float;
pub mod panel;
pub mod reveal;
pub mod scroll;
pub mod tint;

pub use caret::CaretMotion;
pub use float::{FloatFrame, FloatMotion};
pub use panel::PanelMotion;
pub use reveal::RevealMotion;
pub use scroll::ScrollMotion;
pub use tint::TintMotion;
