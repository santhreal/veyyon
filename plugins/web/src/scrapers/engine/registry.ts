import { ACADEMIC_PAPER_DECLARATIONS } from "../declarations/academic-papers";
import { BUSINESS_DECLARATIONS } from "../declarations/business";
import { DISCUSSION_DECLARATIONS } from "../declarations/discussions";
import { DOCUMENTATION_DECLARATIONS } from "../declarations/documentation";
import { MEDIA_DECLARATIONS } from "../declarations/media";
import { PACKAGE_REGISTRY_DECLARATIONS } from "../declarations/package-registries";
import { SECURITY_ADVISORY_DECLARATIONS } from "../declarations/security-advisories";
import type { SpecialHandler } from "../types";
import type { AcademicMatch, AcademicPaperDeclaration } from "./academic-paper";
import { createAcademicPaperHandler } from "./academic-paper";
import type { BusinessDeclaration } from "./business";
import { createBusinessHandler } from "./business";
import type { DiscussionDeclaration } from "./discussion";
import { createDiscussionHandler } from "./discussion";
import type { DocDeclaration } from "./documentation";
import { createDocumentationHandler } from "./documentation";
import type { MediaDeclaration } from "./media";
import { createMediaHandler } from "./media";
import type { PackageRegistryDeclaration } from "./package-registry";
import { createPackageRegistryHandler } from "./package-registry";
import type { SecurityAdvisoryDeclaration } from "./security-advisory";
import { createSecurityAdvisoryHandler } from "./security-advisory";

export type DeclarativeDeclaration =
	| PackageRegistryDeclaration
	| AcademicPaperDeclaration
	| SecurityAdvisoryDeclaration
	| DiscussionDeclaration
	| MediaDeclaration
	| DocDeclaration
	| BusinessDeclaration;

export interface DeclarativeSiteEntry {
	site: string;
	method?: string | ((match: AcademicMatch) => string);
	family: "package-registry" | "academic" | "security" | "discussion" | "media" | "documentation" | "business";
	declaration: DeclarativeDeclaration & {
		pathPattern?: RegExp;
		apiUrl?: unknown;
		mapping?: unknown;
		fetch?: unknown;
		customFetch?: unknown;
	};
	createHandler: () => SpecialHandler;
}

export const SITE_DECLARATION_ENTRIES: DeclarativeSiteEntry[] = [
	...PACKAGE_REGISTRY_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "package-registry" as const,
		declaration: decl,
		createHandler: () => createPackageRegistryHandler(decl),
	})),
	...ACADEMIC_PAPER_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "academic" as const,
		declaration: decl,
		createHandler: () => createAcademicPaperHandler(decl),
	})),
	...SECURITY_ADVISORY_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "security" as const,
		declaration: decl,
		createHandler: () => createSecurityAdvisoryHandler(decl),
	})),
	...DISCUSSION_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "discussion" as const,
		declaration: decl,
		createHandler: () => createDiscussionHandler(decl),
	})),
	...MEDIA_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "media" as const,
		declaration: decl,
		createHandler: () => createMediaHandler(decl),
	})),
	...DOCUMENTATION_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "documentation" as const,
		declaration: decl,
		createHandler: () => createDocumentationHandler(decl),
	})),
	...BUSINESS_DECLARATIONS.map(decl => ({
		site: decl.site,
		method: decl.method,
		family: "business" as const,
		declaration: decl,
		createHandler: () => createBusinessHandler(decl),
	})),
];
