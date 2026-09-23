//! Profile directories, and where each one's host is.
//!
//! A host process serves the one profile it was started under, so a window
//! reaches another profile by attaching to that profile's own host. The
//! endpoint each row carries is the address that host binds, which is why a
//! row with none states why instead of leaving a control that cannot connect.

use serde::{Deserialize, Serialize};

/// Every profile on disk, the active one marked, and what a new one may copy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfilesView {
	/// Directory name of the profile the attached host runs under.
	pub active:     String,
	pub entries:    Vec<ProfileView>,
	/// What a new profile may copy, in the order a window offers them.
	pub copy_items: Vec<ProfileCopyItemView>,
}

/// One profile directory under the base config root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileView {
	/// Directory name. The default profile is the literal `default`.
	pub name:           String,
	/// What the profile shows as; the directory name when none was written.
	pub display_name:   String,
	pub root_dir:       String,
	/// The endpoint a window attaches to for this profile, none when no
	/// socket path on this platform fits.
	pub endpoint:       Option<String>,
	/// Why this profile has no addressable endpoint; none when it has one.
	pub endpoint_error: Option<String>,
	/// True for the profile the attached host runs under.
	pub is_active:      bool,
}

/// One item a new profile copies from the profile it is seeded off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileCopyItemView {
	/// The key a create sends back for this item.
	pub key:         String,
	pub label:       String,
	pub description: String,
}

impl ProfilesView {
	/// The row for `name`, if the host listed one.
	#[must_use]
	pub fn entry(&self, name: &str) -> Option<&ProfileView> {
		self.entries.iter().find(|entry| entry.name == name)
	}

	/// The row the attached host runs under, if it listed one.
	#[must_use]
	pub fn active_entry(&self) -> Option<&ProfileView> {
		self.entries.iter().find(|entry| entry.is_active)
	}
}

impl ProfileView {
	/// Whether a window can be opened on this profile: it is another profile
	/// than the attached one, and it states an endpoint to attach to.
	#[must_use]
	pub const fn reachable(&self) -> bool {
		!self.is_active && self.endpoint.is_some()
	}

	/// What the row shows: the display name, with the directory name beside it
	/// when the two differ.
	#[must_use]
	pub fn label(&self) -> String {
		if self.display_name == self.name {
			self.name.clone()
		} else {
			format!("{} ({})", self.display_name, self.name)
		}
	}
}
