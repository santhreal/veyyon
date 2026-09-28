//! Files attached to the next prompt: reading and classifying them by their
//! leading bytes, the limits one prompt holds, and why an attachment cannot be
//! sent to the selected model.

use std::{
	fmt,
	fs::File,
	io::{self, Read},
	path::{Path, PathBuf},
	sync::Arc,
};

use gpui::{Image, ImageFormat, SharedString};
use veyyon_desktop_model::{AttachmentSubmission, InputModality, ModelView};

/// Largest file one attachment reads.
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Largest total the attachments of one prompt reach.
pub const MAX_PROMPT_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Most attachments one prompt holds.
pub const MAX_ATTACHMENTS: usize = 8;

/// What an attachment's bytes are, read from the bytes and never from the
/// file name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaType {
	Png,
	Jpeg,
	Gif,
	Webp,
	Mp4,
	Webm,
	QuickTime,
	Text,
	Pdf,
	Binary,
}

impl MediaType {
	/// The MIME type the host receives.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Png => "image/png",
			Self::Jpeg => "image/jpeg",
			Self::Gif => "image/gif",
			Self::Webp => "image/webp",
			Self::Mp4 => "video/mp4",
			Self::Webm => "video/webm",
			Self::QuickTime => "video/quicktime",
			Self::Text => "text/plain",
			Self::Pdf => "application/pdf",
			Self::Binary => "application/octet-stream",
		}
	}

	/// The input a model needs to read this type; `None` for a document no
	/// model input carries.
	#[must_use]
	pub const fn modality(self) -> Option<InputModality> {
		match self {
			Self::Png | Self::Jpeg | Self::Gif | Self::Webp => Some(InputModality::Image),
			Self::Mp4 | Self::Webm | Self::QuickTime => Some(InputModality::Video),
			Self::Text => Some(InputModality::Text),
			Self::Pdf | Self::Binary => None,
		}
	}

	/// How the chip names the type.
	#[must_use]
	pub const fn spelling(self) -> &'static str {
		match self {
			Self::Png => "PNG",
			Self::Jpeg => "JPEG",
			Self::Gif => "GIF",
			Self::Webp => "WebP",
			Self::Mp4 => "MP4",
			Self::Webm => "WebM",
			Self::QuickTime => "MOV",
			Self::Text => "UTF-8 text",
			Self::Pdf => "PDF",
			Self::Binary => "Binary",
		}
	}

	/// The noun a refusal uses for the type.
	#[must_use]
	pub const fn noun(self) -> &'static str {
		match self.modality() {
			Some(InputModality::Image) => "image",
			Some(InputModality::Video) => "video",
			Some(InputModality::Text) => "text",
			Some(InputModality::Other) | None => "binary document",
		}
	}

	/// The decodable image format, for the chip's thumbnail.
	#[must_use]
	pub const fn image_format(self) -> Option<ImageFormat> {
		match self {
			Self::Png => Some(ImageFormat::Png),
			Self::Jpeg => Some(ImageFormat::Jpeg),
			Self::Gif => Some(ImageFormat::Gif),
			Self::Webp => Some(ImageFormat::Webp),
			_ => None,
		}
	}

	/// Classifies a payload by its leading bytes; `None` for anything that is
	/// not an accepted image or video container.
	#[must_use]
	pub fn sniff(bytes: &[u8]) -> Option<Self> {
		if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
			return Some(Self::Png);
		}
		if bytes.starts_with(b"\xff\xd8\xff") {
			return Some(Self::Jpeg);
		}
		if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
			return Some(Self::Gif);
		}
		if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
			return Some(Self::Webp);
		}
		if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
			return match &bytes[8..12] {
				b"qt  " => Some(Self::QuickTime),
				b"isom" | b"iso2" | b"iso3" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42"
				| b"avc1" | b"dash" | b"M4V " | b"MSNV" => Some(Self::Mp4),
				_ => None,
			};
		}
		if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
			let head = &bytes[..bytes.len().min(64)];
			return head
				.windows(4)
				.any(|window| window == b"webm")
				.then_some(Self::Webm);
		}
		None
	}

	/// Classifies a non-empty payload: a sniffed container, a PDF, UTF-8 text
	/// without control characters, or opaque bytes.
	#[must_use]
	pub fn classify(bytes: &[u8]) -> Option<Self> {
		if bytes.is_empty() {
			return None;
		}
		Some(Self::sniff(bytes).unwrap_or_else(|| {
			if bytes.starts_with(b"%PDF-") {
				Self::Pdf
			} else if std::str::from_utf8(bytes).is_ok_and(|text| {
				text
					.chars()
					.all(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
			}) {
				Self::Text
			} else {
				Self::Binary
			}
		}))
	}
}

/// Where an attachment came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
	/// A file on disk, persisted with the draft.
	Path(PathBuf),
	/// An image pasted from the clipboard, numbered in paste order.
	Clipboard(u64),
}

/// One file waiting to be sent with the next prompt.
#[derive(Clone, Debug)]
pub struct Attachment {
	pub name:    String,
	pub media:   MediaType,
	pub source:  Source,
	pub bytes:   Arc<[u8]>,
	/// The decodable image the chip draws as its thumbnail.
	pub image:   Option<Arc<Image>>,
	/// The opening of a text or opaque payload, for the chip's tooltip.
	pub preview: Option<SharedString>,
}

impl Attachment {
	fn new(name: String, media: MediaType, source: Source, bytes: Vec<u8>) -> Self {
		let image = media
			.image_format()
			.map(|format| Arc::new(Image::from_bytes(format, bytes.clone())));
		let preview = super::tray::preview(media, &bytes);
		Self { name, media, source, bytes: Arc::from(bytes), image, preview }
	}

	/// The size the limits are measured against.
	#[must_use]
	pub fn size(&self) -> u64 {
		self.bytes.len() as u64
	}

	/// The wire form, identified by its place in the prompt and its origin so
	/// two attachments of the same bytes stay two.
	#[must_use]
	pub fn submission(&self, position: usize) -> AttachmentSubmission {
		let origin = match &self.source {
			Source::Path(path) => path.display().to_string(),
			Source::Clipboard(ordinal) => format!("clipboard:{ordinal}"),
		};
		AttachmentSubmission {
			id:         format!("{position}:{origin}"),
			name:       self.name.clone(),
			media_type: self.media.as_str().to_owned(),
			data:       self.bytes.to_vec(),
		}
	}
}

/// Why a file was not attached.
#[derive(Debug)]
pub enum AttachError {
	Unreadable { name: String, source: io::Error },
	NotFile { name: String },
	Empty { name: String },
	TooLarge { name: String, bytes: u64 },
	PromptFull { name: String, bytes: u64, attached: u64 },
	TrayFull { name: String },
	ClipboardFormat,
}

impl fmt::Display for AttachError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Unreadable { name, source } => write!(f, "Cannot read {name}: {source}"),
			Self::NotFile { name } => {
				write!(f, "Cannot attach {name}: only regular files are supported")
			},
			Self::Empty { name } => write!(f, "Cannot attach {name}: it is empty"),
			Self::TooLarge { name, bytes } => write!(
				f,
				"Cannot attach {name}: {} exceeds the {} limit per file",
				human_bytes(*bytes),
				human_bytes(MAX_ATTACHMENT_BYTES)
			),
			Self::PromptFull { name, bytes, attached } => write!(
				f,
				"Cannot attach {name}: {} with the {} already attached exceeds the {} limit per prompt",
				human_bytes(*bytes),
				human_bytes(*attached),
				human_bytes(MAX_PROMPT_ATTACHMENT_BYTES)
			),
			Self::TrayFull { name } => {
				write!(f, "Cannot attach {name}: at most {MAX_ATTACHMENTS} files per prompt")
			},
			Self::ClipboardFormat => {
				write!(f, "Cannot attach the clipboard image: its format is not accepted")
			},
		}
	}
}

fn name_of(path: &Path) -> String {
	path
		.file_name()
		.map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

/// Reads and classifies the file at `path`. The size is checked before the
/// read and the read is bounded, so a growing file allocates no more than the
/// limit.
pub fn read_file(path: &Path) -> Result<Attachment, AttachError> {
	let name = name_of(path);
	let unreadable = |source| AttachError::Unreadable { name: name.clone(), source };
	let file = File::open(path).map_err(unreadable)?;
	let metadata = file.metadata().map_err(unreadable)?;
	if !metadata.is_file() {
		return Err(AttachError::NotFile { name });
	}
	if metadata.len() > MAX_ATTACHMENT_BYTES {
		return Err(AttachError::TooLarge { name, bytes: metadata.len() });
	}
	let mut data = Vec::new();
	file
		.take(MAX_ATTACHMENT_BYTES + 1)
		.read_to_end(&mut data)
		.map_err(unreadable)?;
	if data.len() as u64 > MAX_ATTACHMENT_BYTES {
		return Err(AttachError::TooLarge { name, bytes: data.len() as u64 });
	}
	let media =
		MediaType::classify(&data).ok_or_else(|| AttachError::Empty { name: name.clone() })?;
	Ok(Attachment::new(name, media, Source::Path(path.to_path_buf()), data))
}

/// The attachment a pasted clipboard image becomes.
pub fn from_clipboard(image: &Image, ordinal: u64) -> Result<Attachment, AttachError> {
	let media = MediaType::sniff(&image.bytes).ok_or(AttachError::ClipboardFormat)?;
	let name = format!("Pasted image {ordinal}");
	if image.bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
		return Err(AttachError::TooLarge { name, bytes: image.bytes.len() as u64 });
	}
	Ok(Attachment::new(name, media, Source::Clipboard(ordinal), image.bytes.clone()))
}

/// Whether `new` fits beside `tray`: the count and the prompt total.
pub fn admit(tray: &[Attachment], new: &Attachment) -> Result<(), AttachError> {
	if tray.len() >= MAX_ATTACHMENTS {
		return Err(AttachError::TrayFull { name: new.name.clone() });
	}
	let attached = tray
		.iter()
		.fold(0_u64, |sum, item| sum.saturating_add(item.size()));
	if attached.saturating_add(new.size()) > MAX_PROMPT_ATTACHMENT_BYTES {
		return Err(AttachError::PromptFull { name: new.name.clone(), bytes: new.size(), attached });
	}
	Ok(())
}

/// Why `attachment` cannot be sent to `model`, or `None` when it can.
#[must_use]
pub fn rejection(attachment: &Attachment, model: Option<&ModelView>) -> Option<String> {
	let Some(modality) = attachment.media.modality() else {
		return Some(format!(
			"{} attachments are not supported by the host; attach UTF-8 text instead",
			attachment.media.spelling()
		));
	};
	match model.and_then(|model| model.accepts(modality)) {
		Some(true) => None,
		Some(false) => Some(format!(
			"{} does not accept {} attachments",
			model.map_or("Selected model", |model| model.name.as_str()),
			attachment.media.noun()
		)),
		None => {
			Some(format!("Selected model's {} input support is unknown", attachment.media.noun()))
		},
	}
}

/// The first reason the tray cannot be sent with a prompt to `model`.
#[must_use]
pub fn submission_rejection(tray: &[Attachment], model: Option<&ModelView>) -> Option<String> {
	if tray.len() > MAX_ATTACHMENTS {
		return Some(format!("Cannot send more than {MAX_ATTACHMENTS} attachments"));
	}
	let total = tray
		.iter()
		.fold(0_u64, |sum, item| sum.saturating_add(item.size()));
	if total > MAX_PROMPT_ATTACHMENT_BYTES {
		return Some("Cannot send attachments: total size exceeds the prompt limit".to_owned());
	}
	tray.iter().find_map(|attachment| {
		rejection(attachment, model)
			.map(|reason| format!("Cannot send {}: {reason}", attachment.name))
	})
}

/// A size as it is read: `820 KB`, `12.4 MB`.
#[must_use]
pub fn human_bytes(bytes: u64) -> String {
	const KB: f64 = 1000.0;
	const MB: f64 = KB * 1000.0;
	const GB: f64 = MB * 1000.0;
	let value = bytes as f64;
	if value < KB {
		format!("{bytes} B")
	} else if value < MB {
		format!("{:.0} KB", value / KB)
	} else if value < GB {
		format!("{:.1} MB", value / MB)
	} else {
		format!("{:.2} GB", value / GB)
	}
}
