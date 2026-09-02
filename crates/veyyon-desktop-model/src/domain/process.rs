use serde::{Deserialize, Serialize};

/// Supervised child process metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessView {
	/// Process display name.
	pub name:          String,
	/// Operating system process ID if currently running.
	pub pid:           Option<u32>,
	/// Status summary string (e.g., "running", "exited").
	pub status:        String,
	/// Executable or application command name.
	pub application:   String,
	/// Command line argument list.
	pub args:          Vec<String>,
	/// Working directory of the process.
	pub cwd:           String,
	/// Process lifetime policy.
	pub lifetime:      String,
	/// Unix timestamp in milliseconds when the process was started.
	pub started_at_ms: u64,
	/// Exit status code if the process completed.
	pub exit_code:     Option<i32>,
	/// Termination initiator or reason if stopped.
	pub terminated_by: Option<String>,
}

/// Incremental log line chunk from a supervised process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogsChunk {
	/// Name of the process producing log lines.
	pub process: String,
	/// Log line text items.
	pub lines:   Vec<String>,
	/// Host log cursor position.
	pub cursor:  u64,
	/// When true, clears previous log buffer.
	pub reset:   bool,
}

/// Maximum number of log lines retained per supervised process.
pub const PROCESS_LOG_CAPACITY_LINES: usize = 10_000;

/// Bounded log output buffer for a supervised process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLogView {
	/// Retained log lines.
	pub lines:  Vec<String>,
	/// Current cursor index.
	pub cursor: u64,
}

impl Default for ProcessLogView {
	fn default() -> Self {
		Self::new()
	}
}

impl ProcessLogView {
	/// Creates an empty process log buffer.
	#[must_use]
	pub const fn new() -> Self {
		Self { lines: Vec::new(), cursor: 0 }
	}

	/// Appends an incoming log chunk, updating lines, cursor, and enforcing the
	/// capacity bound.
	pub fn append_chunk(&mut self, chunk: ProcessLogsChunk) {
		if chunk.reset {
			self.lines.clear();
		}
		self.cursor = chunk.cursor;
		self.lines.extend(chunk.lines);
		if self.lines.len() > PROCESS_LOG_CAPACITY_LINES {
			let overflow = self.lines.len() - PROCESS_LOG_CAPACITY_LINES;
			self.lines.drain(..overflow);
		}
	}
}
