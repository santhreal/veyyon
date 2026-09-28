//! What the terminal drawer reads beside the store: how much output each
//! terminal and process has produced since its last reset.
//!
//! The store keeps a bounded tail of each stream, so once a stream passes
//! its bound the tail's length stops growing while output still arrives. The
//! marks count every byte and line the host sent, which is what lets the
//! drawer feed its emulator only the output it has not seen, however long the
//! stream has run.

use std::collections::HashMap;

use veyyon_desktop_model::{Capability, CapabilityStatus, ProcessLogsChunk, TerminalOutputChunk};

use super::AppState;

/// How far one output stream has run: `total` units since the reset that
/// began `generation`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamMark {
	/// The count of resets the host sent for the stream.
	pub generation: u64,
	/// Bytes of a terminal, or lines of a process, since that reset.
	pub total:      u64,
}

impl StreamMark {
	/// Counts `units` more, or restarts the count at `units` for a reset.
	fn advance(&mut self, units: usize, reset: bool) {
		let units = u64::try_from(units).unwrap_or(u64::MAX);
		if reset {
			self.generation += 1;
			self.total = units;
		} else {
			self.total = self.total.saturating_add(units);
		}
	}
}

/// The marks of every terminal and process the host streamed output for.
#[derive(Debug, Default)]
pub(super) struct DrawerStreams {
	terminals: HashMap<String, StreamMark>,
	processes: HashMap<String, StreamMark>,
}

impl AppState {
	/// How far `terminal`'s output has run; the default for one that sent
	/// none.
	pub fn terminal_mark(&self, terminal: &str) -> StreamMark {
		self
			.streams
			.terminals
			.get(terminal)
			.copied()
			.unwrap_or_default()
	}

	/// How far `process`'s log has run; the default for one that sent none.
	pub fn process_mark(&self, process: &str) -> StreamMark {
		self
			.streams
			.processes
			.get(process)
			.copied()
			.unwrap_or_default()
	}

	/// Whether the host runs terminals or supervises processes. A host that
	/// offers neither, or has not said yet, has no drawer: a drawer that
	/// appears mid-attach is a surface nothing asked for.
	pub fn drawer_offered(&self) -> bool {
		[Capability::Terminals, Capability::ProcessSupervisor]
			.into_iter()
			.any(|capability| *self.store.capabilities.get(capability) == CapabilityStatus::Available)
	}

	/// Whether the drawer offers the supervisor's tab: every host but one
	/// that declined it, so the tab strip does not reflow when the attach
	/// lands and the first process can be started from it.
	pub const fn supervisor_offered(&self) -> bool {
		!matches!(
			self.store.capabilities.get(Capability::ProcessSupervisor),
			CapabilityStatus::Unavailable { .. }
		)
	}

	/// Counts a terminal output chunk before the store takes it.
	pub(super) fn note_terminal_output(&mut self, chunk: &TerminalOutputChunk) {
		self
			.streams
			.terminals
			.entry(chunk.terminal.clone())
			.or_default()
			.advance(chunk.data.len(), chunk.reset);
	}

	/// Counts a process log chunk before the store takes it.
	pub(super) fn note_process_logs(&mut self, chunk: &ProcessLogsChunk) {
		self
			.streams
			.processes
			.entry(chunk.process.clone())
			.or_default()
			.advance(chunk.lines.len(), chunk.reset);
	}
}
