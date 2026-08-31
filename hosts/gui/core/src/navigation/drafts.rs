//! What a reader has written and attached but not sent.
//!
//! A draft belongs to its conversation and outlives the field it was typed in.
//! An attachment is local until the host acknowledges it, so its state is here
//! rather than in a replica.

use crate::model::*;

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct Draft {
	pub text:        String,
	pub selection:   Option<(usize, usize)>,
	pub caret:       usize,
	pub submission:  CommandState,
	pub attachments: Vec<LocalAttachment>,
}

impl Draft {
	pub fn submission_attachments(&self) -> Vec<AttachmentSubmission> {
		self
			.attachments
			.iter()
			.filter_map(LocalAttachment::submission)
			.collect()
	}
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocalAttachment {
	pub id:            AttachmentId,
	pub kind:          AttachmentKind,
	pub state:         AttachmentState,
	pub size_bytes:    Option<u64>,
	pub mime_type:     Option<String>,
	pub preview_text:  Option<String>,
	pub preview_bytes: Option<Vec<u8>>,
}

impl LocalAttachment {
	pub fn new(id: AttachmentId, kind: AttachmentKind) -> Self {
		let size_bytes = kind.estimated_size_bytes();
		let mime_type = Some(kind.inferred_mime().to_owned());
		let preview_text = kind.initial_preview_text();
		Self {
			id,
			kind,
			state: AttachmentState::Selected,
			size_bytes,
			mime_type,
			preview_text,
			preview_bytes: None,
		}
	}

	pub fn size(&self) -> u64 {
		self
			.size_bytes
			.unwrap_or_else(|| self.kind.estimated_size_bytes().unwrap_or(0))
	}

	pub fn formatted_size(&self) -> String {
		format_size(self.size())
	}

	pub fn display_type(&self) -> String {
		if let Some(mime) = &self.mime_type {
			mime.clone()
		} else {
			self.kind.inferred_mime().to_owned()
		}
	}

	pub fn is_image(&self) -> bool {
		matches!(self.kind, AttachmentKind::Image { .. })
			|| self
				.mime_type
				.as_deref()
				.is_some_and(|m| m.starts_with("image/"))
			|| self.kind.inferred_mime().starts_with("image/")
	}

	pub fn is_text(&self) -> bool {
		matches!(
			self.kind,
			AttachmentKind::TextRange { .. }
				| AttachmentKind::TerminalSelection { .. }
				| AttachmentKind::ReviewComment { .. }
		) || self
			.mime_type
			.as_deref()
			.is_some_and(|m| m.starts_with("text/"))
			|| self.kind.inferred_mime().starts_with("text/")
	}

	pub fn is_binary(&self) -> bool {
		!self.is_image() && !self.is_text()
	}

	pub fn submission(&self) -> Option<AttachmentSubmission> {
		if !matches!(self.state, AttachmentState::Selected | AttachmentState::Ready) {
			return None;
		}
		let source = match &self.kind {
			AttachmentKind::File { path } => AttachmentSource::File { path: path.clone() },
			AttachmentKind::Image { path, alt } => {
				AttachmentSource::Image { path: path.clone(), alt: alt.clone() }
			},
			AttachmentKind::TextRange { path, start_line, end_line, text } => {
				AttachmentSource::TextRange {
					path:       path.clone(),
					start_line: *start_line,
					end_line:   *end_line,
					text:       text.clone(),
				}
			},
			AttachmentKind::TerminalSelection { terminal, text } => {
				AttachmentSource::TerminalSelection {
					terminal: terminal.clone(),
					text:     text.clone(),
				}
			},
			AttachmentKind::ReviewComment { path, start_line, end_line, text } => {
				AttachmentSource::ReviewComment {
					path:       path.clone(),
					start_line: *start_line,
					end_line:   *end_line,
					text:       text.clone(),
				}
			},
		};
		Some(AttachmentSubmission { id: self.id.clone(), source })
	}
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttachmentKind {
	File { path: String },
	Image { path: String, alt: Option<String> },
	TextRange { path: String, start_line: u32, end_line: u32, text: String },
	TerminalSelection { terminal: TerminalId, text: String },
	ReviewComment { path: String, start_line: u32, end_line: u32, text: String },
}

impl AttachmentKind {
	pub fn all_examples() -> Vec<Self> {
		vec![
			Self::File { path: "document.pdf".to_owned() },
			Self::Image { path: "diagram.png".to_owned(), alt: Some("Architecture".to_owned()) },
			Self::TextRange {
				path:       "src/lib.rs".to_owned(),
				start_line: 1,
				end_line:   10,
				text:       "pub fn example() {\n\tprintln!(\"hello\");\n}\n".to_owned(),
			},
			Self::TerminalSelection {
				terminal: TerminalId::new("term-1").expect("valid id"),
				text:     "$ cargo test\ntest result: ok. 42 passed".to_owned(),
			},
			Self::ReviewComment {
				path:       "src/main.rs".to_owned(),
				start_line: 15,
				end_line:   15,
				text:       "Consider handling this error explicitly".to_owned(),
			},
		]
	}

	pub fn inferred_mime(&self) -> &'static str {
		match self {
			Self::File { path } => mime_from_path(path),
			Self::Image { path, .. } => mime_from_path(path),
			Self::TextRange { .. } => "text/plain",
			Self::TerminalSelection { .. } => "text/x-terminal-transcript",
			Self::ReviewComment { .. } => "text/x-review-comment",
		}
	}

	pub fn estimated_size_bytes(&self) -> Option<u64> {
		match self {
			Self::File { .. } => None,
			Self::Image { .. } => None,
			Self::TextRange { text, .. } => Some(text.len() as u64),
			Self::TerminalSelection { text, .. } => Some(text.len() as u64),
			Self::ReviewComment { text, .. } => Some(text.len() as u64),
		}
	}

	pub fn initial_preview_text(&self) -> Option<String> {
		match self {
			Self::TextRange { text, .. }
			| Self::TerminalSelection { text, .. }
			| Self::ReviewComment { text, .. } => Some(text.clone()),
			Self::File { .. } | Self::Image { .. } => None,
		}
	}
}

pub fn mime_from_path(path: &str) -> &'static str {
	let lower = path.to_ascii_lowercase();
	if lower.ends_with(".png") {
		"image/png"
	} else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
		"image/jpeg"
	} else if lower.ends_with(".gif") {
		"image/gif"
	} else if lower.ends_with(".webp") {
		"image/webp"
	} else if lower.ends_with(".svg") {
		"image/svg+xml"
	} else if lower.ends_with(".rs") {
		"text/x-rust"
	} else if lower.ends_with(".ts") || lower.ends_with(".tsx") {
		"text/typescript"
	} else if lower.ends_with(".js") || lower.ends_with(".jsx") {
		"text/javascript"
	} else if lower.ends_with(".py") {
		"text/x-python"
	} else if lower.ends_with(".json") {
		"application/json"
	} else if lower.ends_with(".toml") {
		"text/x-toml"
	} else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
		"text/yaml"
	} else if lower.ends_with(".md") {
		"text/markdown"
	} else if lower.ends_with(".txt") {
		"text/plain"
	} else if lower.ends_with(".pdf") {
		"application/pdf"
	} else if lower.ends_with(".zip") || lower.ends_with(".tar") || lower.ends_with(".gz") {
		"application/zip"
	} else {
		"application/octet-stream"
	}
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttachmentState {
	Selected,
	Uploading { progress_milli: u16 },
	Ready,
	Failed { message: String, retryable: bool },
	NeedsReattach { reason: String },
	Refused { reason: AttachmentRefusalReason },
}
