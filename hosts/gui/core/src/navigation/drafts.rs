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
	pub id:    AttachmentId,
	pub kind:  AttachmentKind,
	pub state: AttachmentState,
}

impl LocalAttachment {
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttachmentState {
	Selected,
	Uploading { progress_milli: u16 },
	Ready,
	Failed { message: String, retryable: bool },
	NeedsReattach { reason: String },
}
