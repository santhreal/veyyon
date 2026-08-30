//! What a rendering surface can do.
//!
//! Mirrors `PresentationCapabilities` from
//! `@veyyon/wire/presentation/context`. A session degrades against these rather
//! than assuming, so the GPU front end reports its own answers rather than
//! inheriting a terminal's.
//!
//! The rest of `PresentationContext` — the methods a session calls — is not
//! mirrored. Those are calls, not data: the GUI receives them over its
//! transport as messages and answers with [`crate::UiEvent`], so a Rust trait
//! with the same method list would describe nothing that exists here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationCapabilities {
	/// Inline images can be displayed.
	pub images:            bool,
	/// True colour is available; false means the renderer quantizes.
	pub true_color:        bool,
	/// Pointer events are reported.
	pub mouse:             bool,
	/// Hyperlinks can be attached to text.
	pub hyperlinks:        bool,
	/// The surface keeps its own scrollback above the viewport.
	pub native_scrollback: bool,
	/// Text can be styled bold, italic or underlined.
	pub text_styles:       bool,
}

impl PresentationCapabilities {
	/// What a GPU window can do.
	///
	/// Every capability except native scrollback: the transcript is a rendered
	/// list the front end scrolls itself, so there is no host scrollback above
	/// the viewport for the session to write into.
	pub const GPU: PresentationCapabilities = PresentationCapabilities {
		images:            true,
		true_color:        true,
		mouse:             true,
		hyperlinks:        true,
		native_scrollback: false,
		text_styles:       true,
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn capabilities_deserialize_from_the_wire_shape() {
		let json = r#"{
			"images": true,
			"trueColor": true,
			"mouse": true,
			"hyperlinks": true,
			"nativeScrollback": false,
			"textStyles": true
		}"#;
		let capabilities: PresentationCapabilities =
			serde_json::from_str(json).expect("deserializes");
		assert_eq!(capabilities, PresentationCapabilities::GPU);
	}

	/// The GPU surface does not claim native scrollback. A session that believed
	/// it would stop rendering history the front end is responsible for, and the
	/// transcript would end at the viewport.
	#[test]
	fn the_gpu_surface_does_not_claim_native_scrollback() {
		const { assert!(!PresentationCapabilities::GPU.native_scrollback) };
	}
}
