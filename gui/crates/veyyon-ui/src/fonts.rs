//! Which font families the window draws with.
//!
//! Not part of the theme: a theme changes colour, and a font change must not
//! arrive with a colour change. Not a fixed constant either, because a family
//! named here that is not installed renders as whatever the platform
//! substitutes, which on Linux is frequently not monospaced at all.
//!
//! So each role carries a candidate list, and the first installed candidate
//! wins. [`pick`] makes that decision over a plain list of names and is checked
//! directly; [`Typography::resolve`] is the part that asks the window what is
//! installed.

use gpui::{App, Global, SharedString};

/// Candidates for the interface font, best first.
///
/// The last entry is the platform's own default sans family, which is present
/// by definition, so the list cannot come up empty.
pub const UI_CANDIDATES: &[&str] = &[
	"Inter",
	"SF Pro Text",
	"Segoe UI Variable Text",
	"Segoe UI",
	"Cantarell",
	"Noto Sans",
	"DejaVu Sans",
	"Helvetica",
	"Arial",
	"sans-serif",
];

/// Candidates for the monospace font, best first.
///
/// Same shape, and the same guarantee at the end: `monospace` resolves to
/// whatever the platform considers fixed-pitch.
pub const MONO_CANDIDATES: &[&str] = &[
	"Zed Plex Mono",
	"JetBrains Mono",
	"Berkeley Mono",
	"SF Mono",
	"Cascadia Code",
	"Consolas",
	"Source Code Pro",
	"Menlo",
	"DejaVu Sans Mono",
	"Liberation Mono",
	"monospace",
];

/// The families the window resolved to.
#[derive(Debug, Clone)]
pub struct Typography {
	pub ui:   SharedString,
	pub mono: SharedString,
}

impl Global for Typography {}

impl Typography {
	/// Resolve both families against what is installed, and install the result.
	pub fn install(cx: &mut App) {
		let installed = cx.text_system().all_font_names();
		let typography = Typography::resolve(&installed);
		cx.set_global(typography);
	}

	/// Resolve both families against a list of installed family names.
	pub fn resolve(installed: &[String]) -> Typography {
		Typography {
			ui:   pick(UI_CANDIDATES, installed).into(),
			mono: pick(MONO_CANDIDATES, installed).into(),
		}
	}
}

/// The first candidate that is installed, or the last candidate when none is.
///
/// Falling back to the last rather than the first is deliberate: the lists end
/// with a generic family the platform always resolves, so an unrecognised
/// environment gets something readable instead of a name nobody has.
pub fn pick(candidates: &[&'static str], installed: &[String]) -> &'static str {
	debug_assert!(!candidates.is_empty(), "a candidate list cannot be empty");
	candidates
		.iter()
		.copied()
		.find(|candidate| installed.iter().any(|name| name == candidate))
		.unwrap_or_else(|| candidates.last().copied().unwrap_or("monospace"))
}

/// Reading the resolved families.
pub trait ActiveTypography {
	fn typography(&self) -> &Typography;

	fn ui_family(&self) -> SharedString {
		self.typography().ui.clone()
	}

	fn mono_family(&self) -> SharedString {
		self.typography().mono.clone()
	}
}

impl ActiveTypography for App {
	fn typography(&self) -> &Typography {
		self.global::<Typography>()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn names(list: &[&str]) -> Vec<String> {
		list.iter().map(|name| (*name).to_owned()).collect()
	}

	/// The best installed candidate wins, not the first installed one found by
	/// scanning what is installed. The order that matters is the candidate list,
	/// which is the preference; the installed list is whatever the OS reports.
	#[test]
	fn the_best_installed_candidate_wins() {
		let installed = names(&["Consolas", "DejaVu Sans Mono", "JetBrains Mono", "Comic Sans MS"]);
		assert_eq!(pick(MONO_CANDIDATES, &installed), "JetBrains Mono");
	}

	/// Nothing installed still produces a family, and it is the generic one at
	/// the end of the list rather than the aspirational one at the front.
	#[test]
	fn an_empty_system_falls_back_to_the_generic_family() {
		assert_eq!(pick(MONO_CANDIDATES, &[]), "monospace");
		assert_eq!(pick(UI_CANDIDATES, &[]), "sans-serif");
	}

	/// Matching is exact. A family whose name merely contains a candidate is a
	/// different family, and "JetBrains Mono ExtraBold" is not the regular
	/// weight.
	#[test]
	fn matching_is_exact() {
		let installed = names(&["JetBrains Mono ExtraBold", "Inter Display"]);
		assert_eq!(pick(MONO_CANDIDATES, &installed), "monospace");
		assert_eq!(pick(UI_CANDIDATES, &installed), "sans-serif");
	}

	/// Both lists end with a generic family. Without that the fallback is a
	/// concrete name that may not exist, which is the failure this design exists
	/// to avoid.
	#[test]
	fn both_candidate_lists_end_generic() {
		assert_eq!(UI_CANDIDATES.last().copied(), Some("sans-serif"));
		assert_eq!(MONO_CANDIDATES.last().copied(), Some("monospace"));
	}

	/// No duplicates in a candidate list. A repeated name is a preference stated
	/// twice, and the second statement can never take effect.
	#[test]
	fn candidate_lists_have_no_duplicates() {
		for (what, list) in [("ui", UI_CANDIDATES), ("mono", MONO_CANDIDATES)] {
			let mut sorted = list.to_vec();
			sorted.sort_unstable();
			let before = sorted.len();
			sorted.dedup();
			assert_eq!(sorted.len(), before, "{what} candidates repeat a name");
		}
	}

	/// Resolution picks each role independently: a system with a good mono font
	/// and no good ui font gets the mono font and the generic sans.
	#[test]
	fn the_two_roles_resolve_independently() {
		let installed = names(&["JetBrains Mono"]);
		let typography = Typography::resolve(&installed);
		assert_eq!(typography.mono.as_ref(), "JetBrains Mono");
		assert_eq!(typography.ui.as_ref(), "sans-serif");
	}
}
