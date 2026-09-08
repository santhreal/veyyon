//! Palette result items and the marks a row carries beside its text (§5.8).
//!
//! A row states its title and its description in the two lines a 36px result
//! row holds. What is left over rides in the row's slots: the state a session
//! is in as a leading dot, and the chord that runs a command, or a one-word
//! note about the row, at the trailing edge.

use veyyon_desktop_model::Capability;

use crate::{Intent, keymap::command::Command, model::Badge};

/// The mark a row carries at its trailing edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteMeta {
	/// The command whose chord the row states, resolved against the active
	/// keymap when the row is drawn so an operator override is what shows.
	Chord(Command),
	/// A word about the row itself: the partition a session sits in, the kind
	/// of a browse entry, whether a model reasons or is the one in effect.
	Note(String),
}

impl PaletteMeta {
	/// A note built from parts, joined the way a row's meta reads.
	#[must_use]
	pub fn note(parts: &[&str]) -> Option<Self> {
		let joined = parts.join(" · ");
		(!joined.is_empty()).then_some(Self::Note(joined))
	}

	/// The chord this mark states, read from the active keymap. A command an
	/// operator rebound answers to both chords, and the row states theirs,
	/// since the shipped one is not what they chose. A note states no chord.
	#[must_use]
	pub fn chord(&self, keymap: &crate::keymap::Keymap) -> Option<String> {
		let Self::Chord(command) = self else {
			return None;
		};
		let bound: Vec<crate::keymap::KeymapRow> = keymap
			.rows()
			.into_iter()
			.filter(|row| row.command == *command)
			.collect();
		bound
			.iter()
			.find(|row| row.overridden)
			.or_else(|| bound.first())
			.map(|row| row.chord.clone())
	}
}

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
	pub id:         u64,
	/// Primary label shown in the row.
	pub title:      String,
	/// Secondary description or path text.
	pub subtitle:   Option<String>,
	/// The heading this row sits under, for a list the surface groups. Rows
	/// sharing a heading are contiguous, and the heading is drawn once above
	/// the first of them.
	pub group:      Option<String>,
	/// A name the row is found by and does not draw, for an identity the row
	/// states across two lines: a model's `provider/model` is one query even
	/// though the heading holds the provider and the row holds the id.
	pub search:     Option<String>,
	/// Visual state badge mapped to a status dot.
	pub badge:      Option<Badge>,
	/// The chord that runs the row, or a word about the row itself, drawn at
	/// its trailing edge.
	pub meta:       Option<PaletteMeta>,
	/// The capability the host must carry for this row's action, for a row the
	/// projection prunes rather than lists and refuses (§5.13). `None` is a
	/// row whose action the window carries itself, so no host can decline it.
	pub capability: Option<Capability>,
	/// Target action classification.
	pub kind:       PaletteItemKind,
}

impl PaletteItem {
	/// Creates a command palette item.
	#[must_use]
	pub fn command(
		id: u64,
		title: impl Into<String>,
		intent: Intent,
		chord: Option<Command>,
	) -> Self {
		Self {
			id,
			title: title.into(),
			subtitle: None,
			group: None,
			search: None,
			badge: None,
			meta: chord.map(PaletteMeta::Chord),
			capability: None,
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
		meta: Option<PaletteMeta>,
	) -> Self {
		Self {
			id,
			title: title.into(),
			subtitle: Some(subtitle.into()),
			group: None,
			search: None,
			badge,
			meta,
			capability: None,
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
			group: None,
			search: None,
			badge: None,
			meta: None,
			capability: Some(Capability::Files),
			kind: PaletteItemKind::File { path: p },
		}
	}

	/// Creates a row for one line a content search matched. The row draws the
	/// line it found and states the file and line number under it, and is
	/// found by either, since an operator who typed the text is looking at
	/// rows that all contain it and picks one by where it is.
	#[must_use]
	pub fn content_match(id: u64, path: impl Into<String>, line: u32, preview: &str) -> Self {
		let p = path.into();
		let place = format!("{p}:{line}");
		Self {
			id,
			title: preview.trim().to_string(),
			subtitle: Some(place.clone()),
			group: None,
			search: Some(place),
			badge: None,
			meta: None,
			capability: Some(Capability::Files),
			kind: PaletteItemKind::ContentMatch { path: p, line: Some(line) },
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
			group: None,
			search: None,
			badge: None,
			meta: Some(PaletteMeta::Note("Folder".to_string())),
			capability: Some(Capability::Files),
			kind: PaletteItemKind::Directory { path: p },
		}
	}
}
