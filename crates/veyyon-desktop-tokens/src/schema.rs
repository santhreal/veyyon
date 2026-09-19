use serde::{Deserialize, Serialize};

/// Spacing scale steps referencing s0 through s13.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SpacingStep {
	S0,
	S1,
	S2,
	S3,
	S4,
	S5,
	S6,
	S7,
	S8,
	S9,
	S10,
	S11,
	S12,
	S13,
}

impl SpacingStep {
	/// Returns all valid spacing steps in declaration order.
	pub const fn all() -> [Self; 14] {
		[
			Self::S0,
			Self::S1,
			Self::S2,
			Self::S3,
			Self::S4,
			Self::S5,
			Self::S6,
			Self::S7,
			Self::S8,
			Self::S9,
			Self::S10,
			Self::S11,
			Self::S12,
			Self::S13,
		]
	}

	/// Parses a scale token string such as "s4".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"s0" => Some(Self::S0),
			"s1" => Some(Self::S1),
			"s2" => Some(Self::S2),
			"s3" => Some(Self::S3),
			"s4" => Some(Self::S4),
			"s5" => Some(Self::S5),
			"s6" => Some(Self::S6),
			"s7" => Some(Self::S7),
			"s8" => Some(Self::S8),
			"s9" => Some(Self::S9),
			"s10" => Some(Self::S10),
			"s11" => Some(Self::S11),
			"s12" => Some(Self::S12),
			"s13" => Some(Self::S13),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::S0 => "s0",
			Self::S1 => "s1",
			Self::S2 => "s2",
			Self::S3 => "s3",
			Self::S4 => "s4",
			Self::S5 => "s5",
			Self::S6 => "s6",
			Self::S7 => "s7",
			Self::S8 => "s8",
			Self::S9 => "s9",
			Self::S10 => "s10",
			Self::S11 => "s11",
			Self::S12 => "s12",
			Self::S13 => "s13",
		}
	}
}

/// Corner radius scale steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RadiusStep {
	None,
	Xs,
	Sm,
	Md,
	Lg,
	Xl,
	Xxl,
	Full,
}

impl RadiusStep {
	/// Returns all valid radius steps in declaration order.
	pub const fn all() -> [Self; 8] {
		[Self::None, Self::Xs, Self::Sm, Self::Md, Self::Lg, Self::Xl, Self::Xxl, Self::Full]
	}

	/// Parses a radius token string such as "xl".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"none" => Some(Self::None),
			"xs" => Some(Self::Xs),
			"sm" => Some(Self::Sm),
			"md" => Some(Self::Md),
			"lg" => Some(Self::Lg),
			"xl" => Some(Self::Xl),
			"xxl" => Some(Self::Xxl),
			"full" => Some(Self::Full),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::Xs => "xs",
			Self::Sm => "sm",
			Self::Md => "md",
			Self::Lg => "lg",
			Self::Xl => "xl",
			Self::Xxl => "xxl",
			Self::Full => "full",
		}
	}
}

/// Typographic scale sizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TypeSizeStep {
	Micro,
	Small,
	Body,
	Read,
	Head,
	Lead,
}

impl TypeSizeStep {
	/// Returns all valid type size steps in declaration order.
	pub const fn all() -> [Self; 6] {
		[Self::Micro, Self::Small, Self::Body, Self::Read, Self::Head, Self::Lead]
	}

	/// Parses a type size token string such as "read".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"micro" => Some(Self::Micro),
			"small" => Some(Self::Small),
			"body" => Some(Self::Body),
			"read" => Some(Self::Read),
			"head" => Some(Self::Head),
			"lead" => Some(Self::Lead),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::Micro => "micro",
			Self::Small => "small",
			Self::Body => "body",
			Self::Read => "read",
			Self::Head => "head",
			Self::Lead => "lead",
		}
	}
}

/// Typographic weight steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TypeWeightStep {
	Regular,
	Medium,
	Semibold,
}

impl TypeWeightStep {
	/// Returns all valid type weight steps.
	pub const fn all() -> [Self; 3] {
		[Self::Regular, Self::Medium, Self::Semibold]
	}

	/// Parses a weight token string such as "medium".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"regular" => Some(Self::Regular),
			"medium" => Some(Self::Medium),
			"semibold" => Some(Self::Semibold),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::Regular => "regular",
			Self::Medium => "medium",
			Self::Semibold => "semibold",
		}
	}
}

/// Monospace typography steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MonoSizeStep {
	Small,
	Body,
}

impl MonoSizeStep {
	/// Returns all valid mono size steps.
	pub const fn all() -> [Self; 2] {
		[Self::Small, Self::Body]
	}

	/// Parses a mono size token string.
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"small" => Some(Self::Small),
			"body" => Some(Self::Body),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::Small => "small",
			Self::Body => "body",
		}
	}
}

/// Stroke width steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StrokeStep {
	Hairline,
	Icon,
	Heavy,
}

impl StrokeStep {
	/// Returns all valid stroke steps.
	pub const fn all() -> [Self; 3] {
		[Self::Hairline, Self::Icon, Self::Heavy]
	}

	/// Parses a stroke token string such as "hairline".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"hairline" => Some(Self::Hairline),
			"icon" => Some(Self::Icon),
			"heavy" => Some(Self::Heavy),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::Hairline => "hairline",
			Self::Icon => "icon",
			Self::Heavy => "heavy",
		}
	}
}

/// Icon bounding box steps (§6.8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IconSizeStep {
	Size12,
	Size14,
	#[default]
	Size16,
	Size20,
}

impl IconSizeStep {
	/// Every icon box, smallest first.
	pub const fn all() -> [Self; 4] {
		[Self::Size12, Self::Size14, Self::Size16, Self::Size20]
	}

	/// Parses an icon token string such as "size12".
	pub fn from_token(token: &str) -> Option<Self> {
		match token {
			"size12" => Some(Self::Size12),
			"size14" => Some(Self::Size14),
			"size16" => Some(Self::Size16),
			"size20" => Some(Self::Size20),
			_ => None,
		}
	}

	/// Formats step name as token string.
	pub const fn as_token(self) -> &'static str {
		match self {
			Self::Size12 => "size12",
			Self::Size14 => "size14",
			Self::Size16 => "size16",
			Self::Size20 => "size20",
		}
	}
}
