//! Canonical `ToolView` model and DTO definitions.

pub mod enums;
pub mod text;
pub mod types;

pub use enums::{ViewContentsKind, ViewDiffSide, ViewStatus, ViewTone};
pub use text::{line_text, row_text, view_rows};
pub use types::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowBadge, StatusRowView, TextBlockView,
	ToolPresentation, ToolView, ToolViewContext, ViewCodeLines, ViewDiffLines, ViewHiddenCount,
	ViewLine, ViewNoun, ViewSection, ViewSpan, ViewTailWindow, ViewTreeLines,
};
