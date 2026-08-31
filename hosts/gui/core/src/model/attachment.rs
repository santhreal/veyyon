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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttachmentRefusalReason {
	UnsupportedModality { modality: String },
	UnsupportedType { mime: String },
	SizeExceeded { size_bytes: u64, max_bytes: u64 },
	TooManyAttachments { count: usize, max: usize },
	ModelUnavailable { reason: String },
}

impl AttachmentRefusalReason {
	pub const ALL_VARIANTS: [Self; 5] = [
		Self::UnsupportedModality { modality: String::new() },
		Self::UnsupportedType { mime: String::new() },
		Self::SizeExceeded { size_bytes: 0, max_bytes: 0 },
		Self::TooManyAttachments { count: 0, max: 0 },
		Self::ModelUnavailable { reason: String::new() },
	];

	pub fn all_examples() -> Vec<Self> {
		vec![
			Self::UnsupportedModality { modality: "image".to_owned() },
			Self::UnsupportedType { mime: "application/x-executable".to_owned() },
			Self::SizeExceeded { size_bytes: 25 * 1024 * 1024, max_bytes: 20 * 1024 * 1024 },
			Self::TooManyAttachments { count: 6, max: 5 },
			Self::ModelUnavailable { reason: "Model quota exhausted".to_owned() },
		]
	}

	pub fn reason_text(&self) -> String {
		match self {
			Self::UnsupportedModality { modality } => {
				format!("Model does not accept {modality} attachments")
			},
			Self::UnsupportedType { mime } => {
				format!("Unsupported attachment type: {mime}")
			},
			Self::SizeExceeded { size_bytes, max_bytes } => {
				format!(
					"Attachment size ({}) exceeds model limit ({})",
					format_size(*size_bytes),
					format_size(*max_bytes)
				)
			},
			Self::TooManyAttachments { count, max } => {
				format!("Too many attachments ({count}); maximum allowed is {max}")
			},
			Self::ModelUnavailable { reason } => {
				format!("Selected model is unavailable: {reason}")
			},
		}
	}
}

pub fn format_size(bytes: u64) -> String {
	const KIB: u64 = 1024;
	const MIB: u64 = 1024 * 1024;
	const GIB: u64 = 1024 * 1024 * 1024;
	if bytes >= GIB {
		format!("{:.1} GiB", bytes as f64 / GIB as f64)
	} else if bytes >= MIB {
		format!("{:.1} MiB", bytes as f64 / MIB as f64)
	} else if bytes >= KIB {
		format!("{:.1} KiB", bytes as f64 / KIB as f64)
	} else {
		format!("{bytes} B")
	}
}
