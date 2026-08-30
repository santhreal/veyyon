//! The seven shapes every screen in this product is one of.
//!
//! A front end that draws one surface per screen ends up with one renderer per
//! screen, and thirty renderers drift: the same list gets a different row
//! height, a different selected marker and a different empty state in each. The
//! surfaces here are described by shape instead — a pick list, a form, a board,
//! a report, a tree, a splash, a wizard — so a change to how a list reads is
//! one change.
//!
//! A shape is data only. It names no colour, no size and no element, so the
//! renderer decides how a tone or a badge is drawn and a shape can be built and
//! asserted without a window.
//!
//! # What is a shape and what is a view kind
//!
//! A shape is a whole screen the operator navigates. A [`crate::view`] kind is
//! part of a tool's result inside the transcript. Where the two would overlap,
//! the view kind owns it: a report section holds [`crate::view::Table`] rather
//! than a second table model, and a diff is [`crate::view::Diff`] whether it
//! arrives in a transcript block or fills the diff viewer.
//!
//! # Provisional
//!
//! These shapes are this host's proposal, not a landed contract. The view and
//! session layers mirror TypeScript that exists; nothing describes a screen
//! yet. They move to a shared surface if one appears, which is why they are
//! data with no gpui anywhere near them.

pub mod board;
pub mod form;
pub mod pick;
pub mod report;
pub mod route;
pub mod splash;
pub mod tree;
pub mod wizard;

pub use board::{Board, BoardCard, BoardColumn};
pub use form::{Control, Field, FieldOrigin, Form, FormGroup};
pub use pick::{PickList, PickRow};
pub use report::{Report, ReportSection, ReportStat};
pub use route::{Route, RouteId};
pub use splash::{KeyHint, Splash};
pub use tree::{NodeState, Tree, TreeNode};
pub use wizard::{StepState, Wizard, WizardStep};
