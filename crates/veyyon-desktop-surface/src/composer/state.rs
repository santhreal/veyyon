//! What the composer's footer draws for the open session (§5.4, §5.13).
//!
//! Five controls, hard cap: model, thinking level, queue mode, attachments and
//! the context meter. Each is a projection of something the host reported, so
//! the footer never invents a value: a model it cannot name is a control it
//! does not draw, and a capability the host lacks removes the control rather
//! than disabling it (§5.13).

use std::path::PathBuf;

use veyyon_desktop_model::{InputModality, QueueMode, SessionMode};

use super::{
	media::{AttachmentError, MAX_PROMPT_ATTACHMENT_BYTES, MediaKind, MediaType, Payload},
	preview::{AttachmentPreview, MAX_ATTACHMENTS},
	turn::ModelChoice,
};

/// One model the operator can pick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelOption {
	/// The provider and id the host selects it by.
	pub choice:    ModelChoice,
	/// The name the host displays it under.
	pub name:      String,
	/// Whether the model supports extended reasoning.
	pub reasoning: bool,
	/// The inputs the catalog declares for it; empty when it did not say.
	pub input:     Vec<InputModality>,
}

/// The footer's model control.
///
/// Whether the host accepts `SelectModel` is not held here: the control reads
/// `ControlStates::availability` for `SurfaceId::ComposerModelSelector`, which
/// is the one place that decision is made (§5.13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelControl {
	/// The model in use, as the host reported it.
	pub current: Option<ModelChoice>,
	/// Every model the host offers, in the host's order.
	pub options: Vec<ModelOption>,
}

impl ModelControl {
	/// The active model's catalog row, when the catalog lists it.
	#[must_use]
	pub fn active(&self) -> Option<&ModelOption> {
		let current = self.current.as_ref()?;
		self.options.iter().find(|option| option.choice == *current)
	}

	/// The text the control shows: the current model's display name, its id
	/// when the catalog does not name it, or nothing when no model is active.
	#[must_use]
	pub fn label(&self) -> Option<&str> {
		let current = self.current.as_ref()?;
		Some(
			self
				.active()
				.map_or(current.model.as_str(), |option| option.name.as_str()),
		)
	}

	/// Whether the active model is known to take `modality`: `Some(false)`
	/// when the catalog lists the model without it, `None` when there is no
	/// active model, no catalog row, or a row that declares nothing.
	#[must_use]
	pub fn accepts(&self, modality: InputModality) -> Option<bool> {
		let option = self.active()?;
		if option.input.is_empty() {
			return None;
		}
		Some(option.input.contains(&modality))
	}
}

/// The footer's thinking level control. Absent when the host has no thinking
/// capability, or the active model offers no levels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingControl {
	/// The level in effect.
	pub level:  String,
	/// The levels the active model supports, in the host's order.
	pub levels: Vec<String>,
}

impl ThinkingControl {
	/// The level after the current one, wrapping, so one click steps through
	/// every level the model supports. `None` when there is nowhere to go.
	#[must_use]
	pub fn next(&self) -> Option<&str> {
		if self.levels.len() < 2 {
			return None;
		}
		let index = self.levels.iter().position(|level| *level == self.level);
		let next = index.map_or(0, |index| (index + 1) % self.levels.len());
		self.levels.get(next).map(String::as_str)
	}
}

/// Where an attachment came from, which is also how a duplicate is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentSource {
	/// A file the operator picked, dropped or pasted as a path.
	Path(PathBuf),
	/// An image pasted from the clipboard, numbered in paste order.
	Clipboard(u32),
}

/// One image or clip the next prompt carries, bytes and all.
#[derive(Debug, Clone, Eq)]
pub struct Attachment {
	/// The chip's label: the file name, or `Pasted image N.png`.
	pub name:    String,
	pub source:  AttachmentSource,
	pub media:   MediaType,
	pub payload: Payload,
	pub preview: AttachmentPreview,
}

impl PartialEq for Attachment {
	fn eq(&self, other: &Self) -> bool {
		// Preview pixels are derived and may have independent allocations.
		self.name == other.name
			&& self.source == other.source
			&& self.media == other.media
			&& self.payload == other.payload
	}
}

impl Attachment {
	/// An attachment read from `path`.
	#[must_use]
	pub fn from_path(path: PathBuf, media: MediaType, payload: Payload) -> Self {
		let name = path
			.file_name()
			.map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned());
		let preview = AttachmentPreview::new(media, &payload);
		Self { name, source: AttachmentSource::Path(path), media, payload, preview }
	}

	/// The `ordinal`th image pasted from the clipboard.
	#[must_use]
	pub fn from_clipboard(ordinal: u32, media: MediaType, payload: Payload) -> Self {
		let extension = media.as_str().rsplit('/').next().unwrap_or("bin");
		Self {
			preview: AttachmentPreview::new(media, &payload),
			name: format!("Pasted image {ordinal}.{extension}"),
			source: AttachmentSource::Clipboard(ordinal),
			media,
			payload,
		}
	}

	/// Still or moving.
	#[must_use]
	pub const fn kind(&self) -> MediaKind {
		self.media.kind()
	}

	/// The decoded size.
	#[must_use]
	pub fn bytes(&self) -> u64 {
		self.payload.len()
	}
}

/// How full the context window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextMeter {
	/// Tokens in the window now.
	pub used_tokens:  u64,
	/// The window's ceiling, when the host knows it.
	pub limit_tokens: Option<u64>,
}

impl ContextMeter {
	/// The occupancy as a whole percentage, clamped to 100; `None` without a
	/// ceiling to measure against.
	#[must_use]
	pub fn percent(&self) -> Option<u8> {
		let limit = self.limit_tokens.filter(|limit| *limit > 0)?;
		let scaled = self.used_tokens.saturating_mul(100) / limit;
		Some(u8::try_from(scaled.min(100)).unwrap_or(100))
	}

	/// The label the control shows: a percentage when the ceiling is known,
	/// otherwise the raw count.
	#[must_use]
	pub fn label(&self) -> String {
		match self.percent() {
			Some(percent) => format!("{percent}% context"),
			None => format!("{} tokens", thousands(self.used_tokens)),
		}
	}
}

/// Formats a count with thousands separators.
#[must_use]
pub fn thousands(value: u64) -> String {
	let digits = value.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	for (index, digit) in digits.chars().enumerate() {
		if index > 0 && (digits.len() - index).is_multiple_of(3) {
			out.push(',');
		}
		out.push(digit);
	}
	out
}

/// Everything the footer draws for the open session.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposerState {
	/// The model control, absent until the host reports a model.
	pub model:       Option<ModelControl>,
	/// The thinking control, absent without the capability or levels.
	pub thinking:    Option<ThinkingControl>,
	/// Whether a prompt sent during a turn steers it or queues behind it.
	pub queue_mode:  QueueMode,
	/// The images and clips the next prompt carries, in the order added.
	pub attachments: Vec<Attachment>,
	/// The context meter, absent without a breakdown from the host.
	pub context:     Option<ContextMeter>,
	/// The prompts waiting behind the running turn, in delivery order.
	pub queued:      Vec<String>,
	/// The mode the session runs in, absent when it runs in none.
	///
	/// A mode decides what the agent may do with the prompt about to be sent,
	/// so the footer states it beside the model that will answer it.
	pub mode:        Option<SessionMode>,
}

impl ComposerState {
	/// The decoded size of everything attached.
	#[must_use]
	pub fn attached_bytes(&self) -> u64 {
		self.attachments.iter().map(Attachment::bytes).sum()
	}

	/// Checks `attachment` against the per-prompt ceiling without adding it.
	pub fn admit(&self, attachment: &Attachment) -> Result<(), AttachmentError> {
		if self.attachments.len() >= MAX_ATTACHMENTS {
			return Err(AttachmentError::TrayFull { name: attachment.name.clone() });
		}
		let attached = self.attached_bytes();
		let bytes = attachment.bytes();
		if attached.saturating_add(bytes) > MAX_PROMPT_ATTACHMENT_BYTES {
			return Err(AttachmentError::PromptFull {
				name: attachment.name.clone(),
				bytes,
				attached,
			});
		}
		Ok(())
	}

	/// Adds an attachment, once: the same path attached twice keeps one card.
	/// A clipboard image is always new.
	pub fn attach(&mut self, attachment: Attachment) {
		let duplicate = match &attachment.source {
			AttachmentSource::Path(_) => self
				.attachments
				.iter()
				.any(|a| a.source == attachment.source),
			AttachmentSource::Clipboard(_) => false,
		};
		if !duplicate {
			self.attachments.push(attachment);
		}
	}

	/// Removes the attachment at `index`, if there is one.
	pub fn detach(&mut self, index: usize) {
		if index < self.attachments.len() {
			self.attachments.remove(index);
		}
	}

	/// The visible reason an attachment cannot be dispatched.
	#[must_use]
	pub fn rejection_reason(&self, attachment: &Attachment) -> Option<String> {
		let Some(modality) = attachment.kind().modality() else {
			return Some(format!(
				"{} attachments are not supported by the host; attach UTF-8 text instead",
				attachment.media.spelling()
			));
		};
		if let AttachmentPreview::Unavailable(reason) = &attachment.preview {
			return Some(reason.clone());
		}
		let model = self.model.as_ref();
		match model.and_then(|model| model.accepts(modality)) {
			Some(true) => None,
			Some(false) => Some(format!(
				"{} does not accept {} attachments",
				model
					.and_then(ModelControl::label)
					.unwrap_or("Selected model"),
				attachment.kind().noun()
			)),
			None => {
				Some(format!("Selected model's {} input support is unknown", attachment.kind().noun()))
			},
		}
	}

	/// First refusal in tray order, for the pre-dispatch submission check.
	#[must_use]
	pub fn submission_rejection(&self) -> Option<String> {
		self.submission_rejection_for(&self.attachments)
	}

	/// Validates the actual send payload even when it differs from the visible
	/// tray.
	#[must_use]
	pub fn submission_rejection_for(&self, attachments: &[Attachment]) -> Option<String> {
		if attachments.len() > MAX_ATTACHMENTS {
			return Some(format!("Cannot send more than {MAX_ATTACHMENTS} attachments"));
		}
		let total = attachments
			.iter()
			.fold(0_u64, |sum, item| sum.saturating_add(item.bytes()));
		if total > MAX_PROMPT_ATTACHMENT_BYTES {
			return Some("Cannot send attachments: total size exceeds the prompt limit".into());
		}
		attachments.iter().find_map(|attachment| {
			if attachment.payload.is_empty() {
				return Some(format!("Cannot send {}: it is empty", attachment.name));
			}
			self
				.rejection_reason(attachment)
				.map(|reason| format!("Cannot send {}: {reason}", attachment.name))
		})
	}

	#[must_use]
	pub fn unsupported(&self, attachment: &Attachment) -> bool {
		self.rejection_reason(attachment).is_some()
	}
}
