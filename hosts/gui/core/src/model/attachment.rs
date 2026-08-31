//! Typed prompt attachment submission values.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttachmentSubmission {
	pub id:     super::AttachmentId,
	pub source: AttachmentSource,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttachmentSource {
	File { path: String },
	Image { path: String, alt: Option<String> },
	TextRange { path: String, start_line: u32, end_line: u32, text: String },
	TerminalSelection { terminal: super::TerminalId, text: String },
	ReviewComment { path: String, start_line: u32, end_line: u32, text: String },
}
