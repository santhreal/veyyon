use serde::{Deserialize, Serialize};

/// Mode selecting whether a submitted prompt steers the active turn or queues
/// behind it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum QueueMode {
	#[default]
	Steer,
	Queue,
}
