//! Recorded image and file data presented in transcript artifact rows.

use std::sync::Arc;

/// A transcript attachment or a referenced file, independent of its message
/// role.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Artifact {
	Image {
		media_type: String,
		data:       Arc<[u8]>,
		alt:        Option<String>,
	},
	File {
		path:               String,
		has_content:        bool,
		lines:              Option<u32>,
		bytes:              Option<u64>,
		unavailable_reason: Option<String>,
		image:              Option<Arc<[u8]>>,
	},
}
