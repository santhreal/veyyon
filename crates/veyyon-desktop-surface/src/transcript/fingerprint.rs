//! Turn content fingerprinting for selective list remeasurement (§5.2, §5.3).

use std::hash::{DefaultHasher, Hash, Hasher};

use crate::model::{Block, Turn};

/// Computes a 64-bit structural hash of a turn's content to detect changes.
#[must_use]
pub fn compute_turn_fingerprint(turn: &Turn) -> u64 {
	let mut hasher = DefaultHasher::new();
	match turn {
		Turn::Operator(text) => {
			0u8.hash(&mut hasher);
			text.hash(&mut hasher);
		},
		Turn::OperatorArtifacts { text, artifacts } => {
			2u8.hash(&mut hasher);
			text.hash(&mut hasher);
			artifacts.hash(&mut hasher);
		},
		Turn::Agent { blocks, .. } => {
			1u8.hash(&mut hasher);
			blocks.len().hash(&mut hasher);
			for block in blocks {
				match block {
					Block::Prose(text) => {
						0u8.hash(&mut hasher);
						text.hash(&mut hasher);
					},
					Block::Note { label, text, boundary } => {
						4u8.hash(&mut hasher);
						label.hash(&mut hasher);
						text.hash(&mut hasher);
						boundary.hash(&mut hasher);
					},
					Block::Invoke { call_id, tool, target, result, views } => {
						1u8.hash(&mut hasher);
						call_id.hash(&mut hasher);
						tool.hash(&mut hasher);
						target.hash(&mut hasher);
						result.hash(&mut hasher);
						views.hash(&mut hasher);
					},
					Block::Reason(summary) => {
						2u8.hash(&mut hasher);
						summary.hash(&mut hasher);
					},
					Block::Pane { caption, lines } => {
						3u8.hash(&mut hasher);
						caption.hash(&mut hasher);
						lines.hash(&mut hasher);
					},
					Block::Unknown { producer, lines } => {
						5u8.hash(&mut hasher);
						producer.hash(&mut hasher);
						lines.hash(&mut hasher);
					},
					Block::Artifact(artifact) => {
						6u8.hash(&mut hasher);
						artifact.hash(&mut hasher);
					},
				}
			}
		},
	}
	hasher.finish()
}
