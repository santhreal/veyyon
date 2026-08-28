export const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const GOOGLE_SCOPE_CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

export const GOOGLE_SCOPE_USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";

export const GOOGLE_SCOPE_USERINFO_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";

export const GOOGLE_BASE_OAUTH_SCOPES: readonly string[] = [
	GOOGLE_SCOPE_CLOUD_PLATFORM,
	GOOGLE_SCOPE_USERINFO_EMAIL,
	GOOGLE_SCOPE_USERINFO_PROFILE,
];
