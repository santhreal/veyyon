//! One JSON value per line, in both directions.
//!
//! A frame is a serialised [`HostRequest`] or [`HostEvent`] followed by `\n`.
//! Line framing is what makes the peer writable in any language: the engine
//! side is a Bun process, and a length prefix would be a second thing to agree
//! about. The cost is that a newline may not appear inside a frame, which serde
//! guarantees because it escapes one inside a string.
//!
//! Reading is bounded. A peer that never sends a newline would otherwise grow
//! this buffer until the process dies, and a peer that sends a 4 GB line is the
//! same failure with an extra step, so [`MAX_FRAME_BYTES`] ends the connection
//! instead. The bound is a protocol violation rather than a transient fault:
//! reconnecting would replay it.

use std::io::{self, BufRead, Write};

/// The largest frame this side accepts. A transcript page and a terminal chunk
/// are the two large frames; both are bounded well below this by the engine.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Why a read ended without a frame.
#[derive(Debug)]
pub enum FrameError {
	/// The peer closed cleanly between frames.
	Closed,
	/// The peer closed in the middle of a frame.
	Truncated,
	/// The frame passed [`MAX_FRAME_BYTES`] with no newline.
	TooLarge,
	/// The bytes were a frame and not the JSON this side speaks.
	Malformed(String),
	/// The socket itself failed.
	Io(io::Error),
}

impl FrameError {
	/// Whether reconnecting could produce a different outcome. A protocol fault
	/// repeats forever, so it stops the session rather than restarting it.
	pub fn is_protocol_fault(&self) -> bool {
		matches!(self, Self::TooLarge | Self::Malformed(_))
	}

	/// What to show a reader.
	pub fn message(&self) -> String {
		match self {
			Self::Closed => "the engine closed the connection".to_owned(),
			Self::Truncated => "the engine closed mid-frame".to_owned(),
			Self::TooLarge => {
				format!("a frame passed {MAX_FRAME_BYTES} bytes with no end")
			},
			Self::Malformed(detail) => format!("a frame was not readable: {detail}"),
			Self::Io(error) => error.to_string(),
		}
	}
}

/// Read one line into `frame`, bounded, without allocating per read.
///
/// `frame` is cleared first and holds the line without its newline. The buffer
/// is reused across calls, so a steady stream allocates once.
pub fn read_line(source: &mut impl BufRead, frame: &mut Vec<u8>) -> Result<(), FrameError> {
	frame.clear();
	loop {
		let available = match source.fill_buf() {
			Ok(available) => available,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(FrameError::Io(error)),
		};
		if available.is_empty() {
			return Err(if frame.is_empty() {
				FrameError::Closed
			} else {
				FrameError::Truncated
			});
		}
		if let Some(end) = available.iter().position(|byte| *byte == b'\n') {
			if frame.len() + end > MAX_FRAME_BYTES {
				return Err(FrameError::TooLarge);
			}
			frame.extend_from_slice(&available[..end]);
			source.consume(end + 1);
			return Ok(());
		}
		let taken = available.len();
		if frame.len() + taken > MAX_FRAME_BYTES {
			return Err(FrameError::TooLarge);
		}
		frame.extend_from_slice(available);
		source.consume(taken);
	}
}

/// Read one frame and decode it.
///
/// An empty line is a keep-alive and is skipped rather than reported, so a peer
/// can hold a quiet connection open without inventing a message type.
pub fn read<T: serde::de::DeserializeOwned>(
	source: &mut impl BufRead,
	frame: &mut Vec<u8>,
) -> Result<T, FrameError> {
	loop {
		read_line(source, frame)?;
		if frame.iter().all(u8::is_ascii_whitespace) {
			continue;
		}
		return serde_json::from_slice(frame)
			.map_err(|error| FrameError::Malformed(error.to_string()));
	}
}

/// Encode one frame and write it with its newline.
pub fn write<T: serde::Serialize>(sink: &mut impl Write, value: &T) -> Result<(), FrameError> {
	let mut line =
		serde_json::to_vec(value).map_err(|error| FrameError::Malformed(error.to_string()))?;
	if line.len() > MAX_FRAME_BYTES {
		return Err(FrameError::TooLarge);
	}
	line.push(b'\n');
	sink.write_all(&line).map_err(FrameError::Io)?;
	sink.flush().map_err(FrameError::Io)
}
