//! Which themes this build ships, by name.
//!
//! The palettes live in the kit, because a colour is a rendering concern and
//! this crate draws nothing. The identities live here, because the command
//! palette has to offer every theme as a verb and the store has to accept the
//! name the reader chose: a list only the kit can see would leave theme
//! selection reachable by pointer alone.
//!
//! The two are held together by a kit suite that sweeps this list and asserts a
//! palette for each name, and no palette this list does not name.

/// A theme the reader can choose, without the palette it draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeIdentity {
	pub id:   &'static str,
	pub name: &'static str,
	/// Whether the palette is a dark one, which decides the appearance a window
	/// reports while it is on this theme.
	pub dark: bool,
}

/// Every theme this build ships, in the order the palette and settings offer
/// them.
pub static THEMES: [ThemeIdentity; 4] = [
	ThemeIdentity { id: "dark", name: "Dark", dark: true },
	ThemeIdentity { id: "light", name: "Light", dark: false },
	ThemeIdentity { id: "midnight", name: "Midnight", dark: true },
	ThemeIdentity { id: "sand", name: "Sand Light", dark: false },
];

/// The identity of `id`, matched the way the reader types it: the name is as
/// good as the id, and case is not part of either.
pub fn identity(id: &str) -> Option<&'static ThemeIdentity> {
	let query = id.trim();
	THEMES
		.iter()
		.find(|theme| theme.id.eq_ignore_ascii_case(query) || theme.name.eq_ignore_ascii_case(query))
}
