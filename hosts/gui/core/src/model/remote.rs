//! Transport bookkeeping around engine-owned replica values.

use super::RequestId;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum StaleReason {
	Disconnected,
	Reconnecting,
	RevisionGap { expected: u64, received: u64 },
	RefreshFailed(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum RemoteData<T> {
	Unrequested,
	Loading { request: RequestId },
	Ready(T),
	Empty,
	Stale { value: T, reason: StaleReason },
	Error { message: String, retryable: bool, stale: Option<T> },
}

impl<T> RemoteData<T> {
	pub fn readable(&self) -> Option<&T> {
		match self {
			Self::Ready(value) | Self::Stale { value, .. } => Some(value),
			Self::Error { stale: Some(value), .. } => Some(value),
			Self::Unrequested
			| Self::Loading { .. }
			| Self::Empty
			| Self::Error { stale: None, .. } => None,
		}
	}

	pub fn begin(&mut self, request: RequestId) {
		let prior = std::mem::replace(self, Self::Loading { request });
		if let Self::Ready(value) | Self::Stale { value, .. } = prior {
			*self = Self::Error {
				message:   "refresh pending".to_owned(),
				retryable: false,
				stale:     Some(value),
			};
		}
	}

	pub fn fail(&mut self, message: String, retryable: bool) {
		let prior = std::mem::replace(self, Self::Unrequested);
		let stale = match prior {
			Self::Ready(value) | Self::Stale { value, .. } => Some(value),
			Self::Error { stale, .. } => stale,
			Self::Unrequested | Self::Loading { .. } | Self::Empty => None,
		};
		*self = Self::Error { message, retryable, stale };
	}

	pub fn mark_stale(&mut self, reason: StaleReason) {
		let prior = std::mem::replace(self, Self::Unrequested);
		*self = match prior {
			Self::Ready(value) | Self::Stale { value, .. } => Self::Stale { value, reason },
			Self::Error { message, retryable, stale } => Self::Error { message, retryable, stale },
			other => other,
		};
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum CommandState {
	#[default]
	Idle,
	Pending {
		request: RequestId,
	},
	Failed {
		request: RequestId,
		message: String,
	},
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Versioned<T> {
	pub revision: u64,
	pub value:    T,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn failure_retains_readable_stale_value() {
		let mut data = RemoteData::Ready(String::from("last good"));
		data.fail(String::from("offline"), true);
		assert_eq!(data.readable().map(String::as_str), Some("last good"));
	}

	#[test]
	fn stale_reason_survives_without_erasing_value() {
		let mut data = RemoteData::Ready(vec![1, 2]);
		data.mark_stale(StaleReason::Disconnected);
		assert_eq!(data.readable(), Some(&vec![1, 2]));
	}
}
