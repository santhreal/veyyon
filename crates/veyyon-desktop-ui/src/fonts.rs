//! The typefaces the window draws with, embedded in the binary.
//!
//! Inter sets the interface and `JetBrains Mono` sets code. Both ship under the
//! SIL Open Font License 1.1 (`fonts/*-LICENSE.txt`), and both are compiled in
//! so the first frame never waits on, or falls back from, a system font lookup.

use std::borrow::Cow;

use veyyon_gpui::App;

/// Family name of the interface typeface.
pub const UI_FAMILY: &str = "Inter";

/// Family name of the code typeface.
pub const MONO_FAMILY: &str = "JetBrains Mono";

/// Every embedded font face, as the bytes of its TrueType file.
pub const FACES: [&[u8]; 6] = [
	include_bytes!("../fonts/Inter-Regular.ttf"),
	include_bytes!("../fonts/Inter-Medium.ttf"),
	include_bytes!("../fonts/Inter-SemiBold.ttf"),
	include_bytes!("../fonts/Inter-Italic.ttf"),
	include_bytes!("../fonts/JetBrainsMono-Regular.ttf"),
	include_bytes!("../fonts/JetBrainsMono-Medium.ttf"),
];

/// Registers every embedded face with the application's text system.
///
/// # Errors
///
/// Returns the text system's error when a face cannot be loaded.
pub fn register(cx: &App) -> anyhow::Result<()> {
	cx.text_system()
		.add_fonts(FACES.iter().map(|face| Cow::Borrowed(*face)).collect())
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use super::{FACES, MONO_FAMILY, UI_FAMILY};

	/// The family names the theme sets text in must be the families the
	/// embedded files declare, or text shapes in a fallback face.
	#[test]
	fn the_embedded_faces_declare_the_families_the_theme_names() {
		let mut database = fontdb::Database::new();
		for face in FACES {
			database.load_font_data(face.to_vec());
		}
		assert_eq!(database.len(), FACES.len(), "every embedded file parses as one face");
		let families: BTreeSet<String> = database
			.faces()
			.flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
			.collect();
		assert_eq!(
			families,
			BTreeSet::from([UI_FAMILY.to_string(), MONO_FAMILY.to_string()])
		);
	}
}
