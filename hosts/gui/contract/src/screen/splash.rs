//! A centred message with keys under it.
//!
//! The launch screen and the pause screen are this shape. It is what the window
//! shows when there is nothing to read yet, or when what there was is
//! suspended.

/// A centred message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Splash {
	pub headline: String,
	/// Lines under the headline, in reading order.
	pub lines:    Vec<String>,
	/// Keys the operator can press here.
	pub keys:     Vec<KeyHint>,
	pub footer:   Option<String>,
}

impl Splash {
	pub fn new(headline: impl Into<String>) -> Splash {
		Splash {
			headline: headline.into(),
			lines:    Vec::new(),
			keys:     Vec::new(),
			footer:   None,
		}
	}

	pub fn line(mut self, line: impl Into<String>) -> Splash {
		self.lines.push(line.into());
		self
	}

	pub fn key(mut self, keys: impl Into<String>, action: impl Into<String>) -> Splash {
		self
			.keys
			.push(KeyHint { keys: keys.into(), action: action.into() });
		self
	}
}

/// One key and what it does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyHint {
	/// The chord as an operator reads it: `ctrl-c`, `esc`, `⇧⏎`.
	pub keys:   String,
	pub action: String,
}
