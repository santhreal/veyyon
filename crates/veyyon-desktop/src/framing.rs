use bytes::BytesMut;
use thiserror::Error;
use veyyon_desktop_model::{HostEvent, HostRequest};

/// Maximum allowed frame size: 8 MiB (8,388,608 bytes), matching
/// `packages/coding-agent/src/gui-host/frames.ts:5`.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Errors encountered during frame encoding or decoding.
#[derive(Debug, Error)]
pub enum FramingError {
	#[error("Frame exceeded maximum allowed size of {max_bytes} bytes (got {actual_bytes} bytes)")]
	FrameTooLarge { max_bytes: usize, actual_bytes: usize },
	#[error("Invalid UTF-8 sequence in frame: {0}")]
	InvalidUtf8(#[source] std::str::Utf8Error),
	#[error("Malformed JSON frame: {0}")]
	MalformedJson(String),
	#[error("Failed to serialize request frame: {0}")]
	Serialize(#[source] serde_json::Error),
	#[error("I/O error during framing: {0}")]
	Io(#[source] std::io::Error),
}

/// Line-delimited JSON frame decoder.
///
/// Accumulates raw bytes, splits on newline (`0x0A`), skips empty or
/// whitespace-only keep-alive lines, enforces the 8 MiB buffer size limit, and
/// deserializes frames into [`HostEvent`].
#[derive(Debug, Default)]
pub struct FrameDecoder {
	buffer: BytesMut,
}

impl FrameDecoder {
	/// Creates a new decoder with an empty buffer.
	#[must_use]
	pub fn new() -> Self {
		Self { buffer: BytesMut::new() }
	}

	/// Returns the number of unparsed bytes currently held in the buffer.
	#[must_use]
	pub fn buffered_len(&self) -> usize {
		self.buffer.len()
	}

	/// Clears the internal buffer.
	pub fn clear(&mut self) {
		self.buffer.clear();
	}

	/// Ingests a chunk of raw bytes and yields any complete, parsed
	/// [`HostEvent`] frames.
	///
	/// If the accumulated buffer without a newline exceeds [`MAX_FRAME_BYTES`],
	/// returns [`FramingError::FrameTooLarge`] without growing the buffer
	/// without bound.
	pub fn decode_chunk(&mut self, chunk: &[u8]) -> Result<Vec<HostEvent>, FramingError> {
		if chunk.is_empty() && self.buffer.is_empty() {
			return Ok(Vec::new());
		}

		// Check if adding this chunk without a newline would exceed the maximum allowed
		// frame size
		if self.buffer.len().saturating_add(chunk.len()) > MAX_FRAME_BYTES {
			let current_len = self.buffer.len();
			let has_newline_in_buf = self.buffer.contains(&b'\n');
			let has_newline_in_chunk_budget = if has_newline_in_buf {
				true
			} else {
				let allowed_from_chunk = MAX_FRAME_BYTES.saturating_sub(current_len);
				chunk.iter().take(allowed_from_chunk).any(|&b| b == b'\n')
			};

			if !has_newline_in_chunk_budget {
				return Err(FramingError::FrameTooLarge {
					max_bytes:    MAX_FRAME_BYTES,
					actual_bytes: self.buffer.len().saturating_add(chunk.len()),
				});
			}
		}

		self.buffer.extend_from_slice(chunk);

		let mut events = Vec::new();

		while !self.buffer.is_empty() {
			let Some(newline_index) = self.buffer.iter().position(|&b| b == b'\n') else {
				if self.buffer.len() > MAX_FRAME_BYTES {
					return Err(FramingError::FrameTooLarge {
						max_bytes:    MAX_FRAME_BYTES,
						actual_bytes: self.buffer.len(),
					});
				}
				break;
			};

			if newline_index > MAX_FRAME_BYTES {
				return Err(FramingError::FrameTooLarge {
					max_bytes:    MAX_FRAME_BYTES,
					actual_bytes: newline_index,
				});
			}

			let line_bytes = self.buffer.split_to(newline_index);
			// Consume the newline delimiter
			let _ = self.buffer.split_to(1);

			// Skip empty or whitespace-only lines (keep-alives)
			if line_bytes.iter().all(u8::is_ascii_whitespace) {
				continue;
			}

			let text = std::str::from_utf8(&line_bytes).map_err(FramingError::InvalidUtf8)?;
			let event = serde_json::from_str::<HostEvent>(text)
				.map_err(|err| FramingError::MalformedJson(err.to_string()))?;

			events.push(event);
		}

		Ok(events)
	}
}

/// Serializes a [`HostRequest`] into a single-line JSON payload terminated by
/// `\n`.
pub fn encode_request(request: &HostRequest) -> Result<Vec<u8>, FramingError> {
	let mut payload = serde_json::to_vec(request).map_err(FramingError::Serialize)?;
	payload.push(b'\n');
	Ok(payload)
}
