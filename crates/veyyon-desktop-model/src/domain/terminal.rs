use serde::{Deserialize, Serialize};

/// Execution status of a managed terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalStatus {
	/// Terminal process is active and running.
	Running,
	/// Terminal process exited normally or with a non-zero code.
	Exited {
		/// Process exit code.
		code: i32,
	},
	/// Terminal process failed to spawn or crashed unexpectedly.
	Failed {
		/// Error message describing the failure.
		message: String,
	},
}

/// Managed terminal instance metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalView {
	/// Unique terminal identifier.
	pub id:     String,
	/// Working directory of the terminal process.
	pub cwd:    String,
	/// Shell executable path.
	pub shell:  String,
	/// Column count of the terminal grid.
	pub cols:   u32,
	/// Row count of the terminal grid.
	pub rows:   u32,
	/// Operational state of the terminal.
	pub status: TerminalStatus,
}

/// Incremental terminal output byte stream chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOutputChunk {
	/// Terminal identifier producing the output.
	pub terminal: String,
	/// Monotonic sequence number for ordering and gap detection.
	pub seq:      u64,
	/// Raw ANSI/UTF-8 output bytes.
	pub data:     Vec<u8>,
	/// When true, clears previous scrollback buffer and resets sequence
	/// tracking.
	pub reset:    bool,
}

/// Sequence gap recorded when chunks arrive out of order or with dropped
/// frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeqGap {
	/// Expected sequence number.
	pub expected: u64,
	/// Actually received sequence number.
	pub received: u64,
}

/// Maximum scrollback buffer capacity per terminal (1 MiB).
pub const TERMINAL_SCROLLBACK_CAPACITY_BYTES: usize = 1024 * 1024;

/// Bounded byte scrollback buffer for a single terminal instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalScrollback {
	/// Bounded byte buffer of terminal scrollback data.
	pub data:     Vec<u8>,
	/// Last received chunk sequence number.
	pub last_seq: Option<u64>,
	/// Recorded sequence gap events when chunks arrive out of order.
	pub gaps:     Vec<SeqGap>,
}

impl Default for TerminalScrollback {
	fn default() -> Self {
		Self::new()
	}
}

impl TerminalScrollback {
	/// Creates an empty scrollback buffer.
	#[must_use]
	pub const fn new() -> Self {
		Self { data: Vec::new(), last_seq: None, gaps: Vec::new() }
	}

	/// Appends an incoming chunk to the scrollback buffer, handling resets, gap
	/// detection, and capacity bounds.
	pub fn append_chunk(&mut self, chunk: TerminalOutputChunk) {
		if chunk.reset {
			self.data.clear();
			self.gaps.clear();
			self.last_seq = Some(chunk.seq);
			self.data = chunk.data;
		} else {
			if let Some(prev) = self.last_seq
				&& chunk.seq != prev.saturating_add(1)
			{
				self
					.gaps
					.push(SeqGap { expected: prev.saturating_add(1), received: chunk.seq });
			}
			self.last_seq = Some(chunk.seq);
			self.data.extend(chunk.data);
		}

		if self.data.len() > TERMINAL_SCROLLBACK_CAPACITY_BYTES {
			let overflow = self.data.len() - TERMINAL_SCROLLBACK_CAPACITY_BYTES;
			self.data.drain(..overflow);
		}
	}
}
