//! One driver per kind of animated surface element, each over
//! `gpui::motion::Animator`.

pub mod caret;
pub mod float;
pub mod panel;
pub mod reveal;
pub mod scroll;
pub mod shift;
pub mod tint;

pub use caret::CaretMotion;
pub use float::{FloatFrame, FloatMotion};
pub use panel::PanelMotion;
pub use reveal::RevealMotion;
pub use scroll::ScrollMotion;
pub use shift::ShiftMotion;
pub use tint::TintMotion;
