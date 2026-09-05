//! Palette result items and row rendering (§5.8).
//!
//! Result rows reuse the queue rail's 36px line row implementation directly
//! to ensure visual consistency and shared geometry across surfaces.
use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{Context, IntoElement};

use crate::{
	Intent, ShellView,
	model::{Badge, Row},
	queue::rows::line_row,
};

/// Specific classification and payload for an item in the palette.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteItemKind {
	/// Action executable directly by the shell or host.
	Command { intent: Box<Intent> },
	/// Editor-local action exposed through command search.
	Composer { command: super::commands::ComposerCommand },
	/// Session navigation target.
	Session { id: u64 },
	/// File lookup match in the workspace.
	File { path: String },
	/// Full text search match with optional line number.
	ContentMatch { path: String, line: Option<u32> },
	/// Directory node for project folder navigation.
	Directory { path: String },
	/// Project root selection.
	Project { path: String },
}

/// One actionable item in the command palette (§5.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteItem {
	/// Stable identifier for row selection and indexing.
	pub id:       u64,
	/// Primary label shown in the row.
	pub title:    String,
	/// Secondary description or path text.
	pub subtitle: Option<String>,
	/// Visual state badge mapped to a status dot.
	pub badge:    Option<Badge>,
	/// Key chord hint or file metadata shown at the right edge.
	pub meta:     Option<String>,
	/// Target action classification.
	pub kind:     PaletteItemKind,
}

impl PaletteItem {
	/// Creates a command palette item.
	#[must_use]
	pub fn command(id: u64, title: impl Into<String>, intent: Intent, chord: Option<&str>) -> Self {
		Self {
			id,
			title: title.into(),
			subtitle: None,
			badge: None,
			meta: chord.map(ToString::to_string),
			kind: PaletteItemKind::Command { intent: Box::new(intent) },
		}
	}

	/// Creates a session palette item from queue row attributes.
	#[must_use]
	pub fn session(
		id: u64,
		title: impl Into<String>,
		subtitle: impl Into<String>,
		badge: Option<Badge>,
		meta: Option<String>,
	) -> Self {
		Self {
			id,
			title: title.into(),
			subtitle: Some(subtitle.into()),
			badge,
			meta,
			kind: PaletteItemKind::Session { id },
		}
	}

	/// Creates a file target item.
	#[must_use]
	pub fn file(id: u64, path: impl Into<String>) -> Self {
		let p = path.into();
		Self {
			id,
			title: p.clone(),
			subtitle: None,
			badge: None,
			meta: None,
			kind: PaletteItemKind::File { path: p },
		}
	}

	/// Creates a directory browsing item.
	#[must_use]
	pub fn directory(id: u64, path: impl Into<String>) -> Self {
		let p = path.into();
		Self {
			id,
			title: p.clone(),
			subtitle: None,
			badge: None,
			meta: Some("Folder".to_string()),
			kind: PaletteItemKind::Directory { path: p },
		}
	}

	/// Converts this palette item into a queue `Row` for line rendering.
	#[must_use]
	pub fn to_row(&self) -> Row {
		Row {
			id:       self.id,
			title:    self.title.clone(),
			subtitle: self.subtitle.clone().unwrap_or_default(),
			badge:    self.badge,
			meta:     self.meta.clone(),
		}
	}
}

/// Renders a palette result row using the queue's 36px line row implementation
/// (§5.8).
pub fn palette_line_row(
	row: &Row,
	selected: bool,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	line_row(row, selected, selected, 0.0, geometry, tokens, cx)
}
