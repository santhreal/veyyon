//! Fixtures for the suites that drive `project` and `actions_for` from a
//! synthetic store. Each suite pulls in only what it uses, so a helper unused
//! by one binary is expected.
#![allow(dead_code, reason = "each test binary uses a subset of these fixtures")]

pub mod raster;

use veyyon_desktop_model::{
	ContentBlock, EntryId, MessageRole, QueuePartition, Session, SessionBadge, SessionId,
	TerminalStatus, TerminalView, TranscriptEntry,
};
use veyyon_desktop_surface::{Block, Turn};

pub const NOW_MS: u64 = 10_000_000;

pub fn session(id: &str, partition: QueuePartition, badge: Option<SessionBadge>) -> Session {
	Session {
		id: SessionId::from(id),
		title: format!("title {id}"),
		project_name: "repo".to_string(),
		branch: String::new(),
		partition,
		badge,
		created_at_ms: NOW_MS - 120_000,
		last_recall_at_ms: NOW_MS - 60_000,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

pub fn entry(
	id: &str,
	parent: Option<&str>,
	role: MessageRole,
	content: Vec<ContentBlock>,
) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision: 1,
		timestamp_ms: NOW_MS,
		role,
		content,
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

pub fn terminal(id: &str, status: TerminalStatus) -> TerminalView {
	TerminalView {
		id: id.to_string(),
		cwd: "/repo".to_string(),
		shell: "/bin/sh".to_string(),
		cols: 80,
		rows: 24,
		status,
	}
}

pub fn agent_blocks(turn: &Turn) -> &[Block] {
	match turn {
		Turn::Agent(blocks) => blocks,
		Turn::Operator(text) => panic!("expected an agent turn, got operator turn {text:?}"),
	}
}
