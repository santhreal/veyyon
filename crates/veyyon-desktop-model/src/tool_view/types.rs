//! Canonical data transfer objects for the `ToolView` contract
//! (§contracts/view).
//!
//! Semantic description of tool output and results, independent of any terminal
//! or host renderer.

use serde::{Deserialize, Serialize};

pub use super::enums::{ViewContentsKind, ViewDiffSide, ViewStatus, ViewTone};

/// A short badge label with a semantic tone.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusRowBadge {
	pub label: String,
	pub tone:  ViewTone,
}

/// A run of text with semantic tone, structure, or actionable target.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewSpan {
	pub text:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tone:      Option<ViewTone>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub bold:      bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub italic:    bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub strike:    bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub captured:  bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub symbol:    Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status:    Option<ViewStatus>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub badge:     bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub link:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub file:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub file_line: Option<usize>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub language:  Option<String>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub markdown:  bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub trailing:  bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub live:      bool,
}

impl ViewSpan {
	/// Creates a plain text span with default styling.
	#[must_use]
	pub fn text(text: impl Into<String>) -> Self {
		Self { text: text.into(), ..Default::default() }
	}

	/// Sets semantic tone.
	#[must_use]
	pub const fn tone(mut self, tone: ViewTone) -> Self {
		self.tone = Some(tone);
		self
	}

	/// Sets bold flag.
	#[must_use]
	pub const fn bold(mut self) -> Self {
		self.bold = true;
		self
	}

	/// Sets strike flag.
	#[must_use]
	pub const fn strike(mut self) -> Self {
		self.strike = true;
		self
	}

	/// Sets URL hyperlink target.
	#[must_use]
	pub fn link(mut self, url: impl Into<String>) -> Self {
		self.link = Some(url.into());
		self
	}

	/// Sets file target and optional line number.
	#[must_use]
	pub fn file(mut self, path: impl Into<String>, line: Option<usize>) -> Self {
		self.file = Some(path.into());
		self.file_line = line;
		self
	}

	/// Sets captured process output flag.
	#[must_use]
	pub const fn captured(mut self) -> Self {
		self.captured = true;
		self
	}
}

/// One line of a block: the spans that make it up, in order.
pub type ViewLine = Vec<ViewSpan>;

/// A one-line summary of a call or its result.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusRowView {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status:                Option<ViewStatus>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub emblem:                Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub emblem_tone:           Option<ViewTone>,
	pub title:                 String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title_tone:            Option<ViewTone>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description:           Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description_tone:      Option<ViewTone>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub description_fits:      bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description_link:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description_file:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description_file_line: Option<usize>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub badge:                 Option<StatusRowBadge>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub meta:                  Vec<ViewLine>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub language:              Option<String>,
}

impl StatusRowView {
	/// Creates a status row with title.
	#[must_use]
	pub fn new(title: impl Into<String>) -> Self {
		Self { title: title.into(), ..Default::default() }
	}
}

/// A run of styled text, wrapped and laid out by the host.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextBlockView {
	#[serde(default)]
	pub spans: Vec<ViewSpan>,
}

impl TextBlockView {
	/// Creates a text block from spans.
	#[must_use]
	pub fn new(spans: impl Into<Vec<ViewSpan>>) -> Self {
		Self { spans: spans.into() }
	}

	/// Creates a plain text block from a string.
	#[must_use]
	pub fn text(text: impl Into<String>) -> Self {
		Self { spans: vec![ViewSpan::text(text)] }
	}
}

/// Noun specification for pluralized hidden item counts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewNoun {
	pub one:  String,
	pub many: String,
}

/// What a card held back, allowing the host to provide disclosure gestures.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewHiddenCount {
	pub count:      usize,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub noun:       Option<ViewNoun>,
	#[serde(default)]
	pub revealable: bool,
}

impl ViewHiddenCount {
	/// Formats a human-readable disclosure label.
	#[must_use]
	pub fn format_label(&self) -> String {
		if let Some(noun) = &self.noun {
			if self.count == 1 {
				format!("1 more {}", noun.one)
			} else {
				format!("{} more {}", self.count, noun.many)
			}
		} else if self.count == 1 {
			"1 more line".to_string()
		} else {
			format!("{} more lines", self.count)
		}
	}
}

/// A section the host shows the tail of, bounded by room.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewTailWindow {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max:      Option<usize>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub viewport: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reserve:  Option<usize>,
}

/// Metadata describing source code lines in a section.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewCodeLines {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub language:          Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub first_line_number: Option<usize>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub total_lines:       Option<usize>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub line_numbers:      Option<Vec<Option<usize>>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub lead:              Option<String>,
}

/// Metadata describing a diff in a section.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewDiffLines {
	#[serde(default)]
	pub sides:        Vec<ViewDiffSide>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub line_numbers: Option<Vec<Option<usize>>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub path:         Option<String>,
}

/// Metadata describing tree node hierarchy in a section.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewTreeLines {
	#[serde(default)]
	pub depth: Vec<usize>,
	#[serde(default)]
	pub opens: Vec<bool>,
	#[serde(default)]
	pub last:  Vec<bool>,
}

/// A labelled group of lines inside a block.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewSection {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub label:     Option<String>,
	#[serde(default)]
	pub lines:     Vec<ViewLine>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub separator: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub hidden:    Option<ViewHiddenCount>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tail:      Option<ViewTailWindow>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub list:      bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub code:      Option<ViewCodeLines>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub diff:      Option<ViewDiffLines>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tree:      Option<ViewTreeLines>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub markdown:  bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub clip:      bool,
}

impl ViewSection {
	/// Creates an empty section.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Sets section lines.
	#[must_use]
	pub fn lines(mut self, lines: Vec<ViewLine>) -> Self {
		self.lines = lines;
		self
	}
}

/// A header row with its own lines under it, drawn without a frame.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeadedBlockView {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub header: Option<StatusRowView>,
	#[serde(default)]
	pub lines:  Vec<ViewLine>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub hidden: Option<ViewHiddenCount>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tail:   Option<ViewTailWindow>,
}

/// A titled block of sections, framed by the host.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FramedBlockView {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub header:   Option<StatusRowView>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub state:    Option<ViewStatus>,
	#[serde(default)]
	pub sections: Vec<ViewSection>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub contents: Option<ViewContentsKind>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub gutter:   bool,
}

/// A short notice whose whole body carries one state.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeView {
	pub state:    ViewStatus,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mark:     Option<String>,
	#[serde(default)]
	pub headline: ViewLine,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tag:      Option<String>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub body:     Vec<ViewLine>,
}

/// Everything a host knows how to draw.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolView {
	StatusRow(StatusRowView),
	TextBlock(TextBlockView),
	HeadedBlock(HeadedBlockView),
	FramedBlock(FramedBlockView),
	Notice(NoticeView),
}

/// Host presentation wrapper carrying disclosure state and view.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPresentation {
	pub expanded: bool,
	pub view:     ToolView,
}

/// Context provided by the surface when asking for a view.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolViewContext {
	pub expanded:   bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub partial:    Option<bool>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub frame:      Option<usize>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub has_result: Option<bool>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub frozen:     Option<bool>,
}
