//! Attachment containers and bounded reads. Text uses the host's text input;
//! binary documents can be inspected but cannot be submitted.

use std::{
	fmt,
	io::{self, Read},
	path::{Path, PathBuf},
	sync::Arc,
};

use veyyon_desktop_model::InputModality;
use veyyon_gpui::{Image, ImageFormat};

/// The most one attached file may weigh, decoded.
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// The most one prompt's attachments may weigh together, decoded.
pub const MAX_PROMPT_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

/// Whether a payload is a still image or a moving one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaKind {
	Image,
	Video,
	Text,
	Binary,
}

impl MediaKind {
	/// The model input the host can send; opaque documents have no input
	/// mapping.
	#[must_use]
	pub const fn modality(self) -> Option<InputModality> {
		match self {
			Self::Image => Some(InputModality::Image),
			Self::Video => Some(InputModality::Video),
			Self::Text => Some(InputModality::Text),
			Self::Binary => None,
		}
	}

	/// The word a notice uses for the payload.
	#[must_use]
	pub const fn noun(self) -> &'static str {
		match self {
			Self::Image => "image",
			Self::Video => "video",
			Self::Text => "text",
			Self::Binary => "binary document",
		}
	}
}

/// One of the media types the host accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, strum::EnumIter)]
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
	/// The IANA media type the host is sent.
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

	/// The type as an operator reads it: `PNG`, `WebP`, `MOV`.
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

	/// Still or moving.
	#[must_use]
	pub const fn kind(self) -> MediaKind {
		match self {
			Self::Png | Self::Jpeg | Self::Gif | Self::Webp => MediaKind::Image,
			Self::Mp4 | Self::Webm | Self::QuickTime => MediaKind::Video,
			Self::Text => MediaKind::Text,
			Self::Pdf | Self::Binary => MediaKind::Binary,
		}
	}

	/// The GPUI decoder for an image type; `None` for a video.
	#[must_use]
	pub const fn image_format(self) -> Option<ImageFormat> {
		match self {
			Self::Png => Some(ImageFormat::Png),
			Self::Jpeg => Some(ImageFormat::Jpeg),
			Self::Gif => Some(ImageFormat::Gif),
			Self::Webp => Some(ImageFormat::Webp),
			Self::Mp4 | Self::Webm | Self::QuickTime | Self::Text | Self::Pdf | Self::Binary => None,
		}
	}

	/// The type of a clipboard image, for the formats the host accepts.
	#[must_use]
	pub const fn from_image_format(format: ImageFormat) -> Option<Self> {
		match format {
			ImageFormat::Png => Some(Self::Png),
			ImageFormat::Jpeg => Some(Self::Jpeg),
			ImageFormat::Gif => Some(Self::Gif),
			ImageFormat::Webp => Some(Self::Webp),
			ImageFormat::Svg
			| ImageFormat::Bmp
			| ImageFormat::Tiff
			| ImageFormat::Ico
			| ImageFormat::Pnm => None,
		}
	}

	/// Classifies a payload by its leading bytes. `None` for anything that is
	/// not one of the accepted containers, including an ISO BMFF file whose
	/// brand is audio and a Matroska file that is not `WebM`.
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
			// The EBML header names its DocType within the first bytes.
			let head = &bytes[..bytes.len().min(64)];
			return head
				.windows(4)
				.any(|window| window == b"webm")
				.then_some(Self::Webm);
		}
		None
	}

	/// Classifies a non-empty attachment without trusting its file extension.
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

/// Why a file was not attached.
#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
	#[error("Cannot read {}: {source}", name_of(.path))]
	Unreadable {
		path:   PathBuf,
		#[source]
		source: io::Error,
	},
	#[error("Cannot attach {}: not an image (png, jpeg, gif, webp) or a video (mp4, webm, mov)", name_of(.path))]
	Unsupported { path: PathBuf },
	#[error("Cannot attach {}: it is empty", name_of(.path))]
	Empty { path: PathBuf },
	#[error("Cannot attach {}: {} exceeds the {} limit per file", name_of(.path), human_bytes(*.bytes), human_bytes(MAX_ATTACHMENT_BYTES))]
	TooLarge { path: PathBuf, bytes: u64 },
	#[error("Cannot attach {name}: {} with the {} already attached exceeds the {} limit per prompt", human_bytes(*.bytes), human_bytes(*.attached), human_bytes(MAX_PROMPT_ATTACHMENT_BYTES))]
	PromptFull { name: String, bytes: u64, attached: u64 },
	#[error("Cannot attach {name}: at most {} files per prompt", super::preview::MAX_ATTACHMENTS)]
	TrayFull { name: String },
	#[error("Cannot attach {}: only regular files are supported", name_of(.path))]
	NotFile { path: PathBuf },
	#[error("Cannot attach the clipboard image: {format:?} is not an accepted format")]
	ClipboardFormat { format: ImageFormat },
}

fn name_of(path: &Path) -> String {
	path
		.file_name()
		.map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

/// The bytes of one attachment, held once and shared between the chip that
/// draws it and the submission that sends it.
#[derive(Clone)]
pub enum Payload {
	/// A still image, in the form GPUI decodes for the chip's thumbnail.
	Image(Arc<Image>),
	/// A clip; nothing on this side decodes it.
	Video(Arc<[u8]>),
	/// Text or opaque document bytes, never passed to an image decoder.
	Data(Arc<[u8]>),
}

impl Payload {
	/// The raw bytes, whichever form holds them.
	#[must_use]
	pub fn bytes(&self) -> &[u8] {
		match self {
			Self::Image(image) => image.bytes(),
			Self::Video(bytes) | Self::Data(bytes) => bytes,
		}
	}

	/// The size the ceilings are measured against.
	#[must_use]
	pub fn len(&self) -> u64 {
		self.bytes().len() as u64
	}

	/// Whether there is nothing to send.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.bytes().is_empty()
	}
}

impl PartialEq for Payload {
	/// Two payloads are the same when they share bytes: the chip and the
	/// submission clone one allocation, so this never walks a clip.
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Image(a), Self::Image(b)) => Arc::ptr_eq(a, b) || a.id() == b.id(),
			(Self::Video(a), Self::Video(b)) => Arc::ptr_eq(a, b) || **a == **b,
			(Self::Data(a), Self::Data(b)) => Arc::ptr_eq(a, b) || **a == **b,
			_ => false,
		}
	}
}

impl Eq for Payload {}

impl fmt::Debug for Payload {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Image(image) => write!(f, "Image({} bytes)", image.bytes().len()),
			Self::Video(bytes) => write!(f, "Video({} bytes)", bytes.len()),
			Self::Data(bytes) => write!(f, "Data({} bytes)", bytes.len()),
		}
	}
}

/// Wraps classified bytes in the payload form their type needs.
#[must_use]
pub fn payload_for(media: MediaType, bytes: Vec<u8>) -> Payload {
	match media.image_format() {
		Some(format) => Payload::Image(Arc::new(Image::from_bytes(format, bytes))),
		None if media.kind() == MediaKind::Video => Payload::Video(Arc::from(bytes)),
		None => Payload::Data(Arc::from(bytes)),
	}
}

/// Reads and classifies one file. Sizes are checked before the read, so an
/// oversized file costs a `stat` and nothing more.
pub fn read_media(path: &Path) -> Result<(MediaType, Payload), AttachmentError> {
	let unreadable = |source| AttachmentError::Unreadable { path: path.to_path_buf(), source };
	if !std::fs::metadata(path).map_err(unreadable)?.is_file() {
		return Err(AttachmentError::NotFile { path: path.to_path_buf() });
	}
	let file = std::fs::File::open(path).map_err(unreadable)?;
	let metadata = file.metadata().map_err(unreadable)?;
	if !metadata.is_file() {
		return Err(AttachmentError::NotFile { path: path.to_path_buf() });
	}
	let bytes = metadata.len();
	if bytes == 0 {
		return Err(AttachmentError::Empty { path: path.to_path_buf() });
	}
	if bytes > MAX_ATTACHMENT_BYTES {
		return Err(AttachmentError::TooLarge { path: path.to_path_buf(), bytes });
	}
	// A growing file cannot outrun the metadata check or allocate without a bound.
	let mut data = Vec::new();
	file
		.take(MAX_ATTACHMENT_BYTES + 1)
		.read_to_end(&mut data)
		.map_err(unreadable)?;
	if data.len() as u64 > MAX_ATTACHMENT_BYTES {
		return Err(AttachmentError::TooLarge {
			path:  path.to_path_buf(),
			bytes: data.len() as u64,
		});
	}
	if data.is_empty() {
		return Err(AttachmentError::Empty { path: path.to_path_buf() });
	}
	let media = MediaType::classify(&data)
		.ok_or_else(|| AttachmentError::Empty { path: path.to_path_buf() })?;
	Ok((media, payload_for(media, data)))
}

/// A size as an operator reads it: `820 KB`, `12.4 MB`.
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
