export const SESSION_FILE_EXTENSION = ".jsonl";

export function isSessionFileName(name: string): boolean {
	return name.endsWith(SESSION_FILE_EXTENSION);
}

export function sessionFileStem(name: string): string {
	return isSessionFileName(name) ? name.slice(0, -SESSION_FILE_EXTENSION.length) : name;
}

export function sessionFileName(stem: string): string {
	return isSessionFileName(stem) ? stem : `${stem}${SESSION_FILE_EXTENSION}`;
}

export const SESSION_BACKUP_EXTENSION = ".bak";

export function sessionBackupName(primaryName: string, id: string | number): string {
	return `${primaryName}.${id}${SESSION_BACKUP_EXTENSION}`;
}

export function isSessionBackupName(name: string): boolean {
	return name.endsWith(SESSION_BACKUP_EXTENSION);
}

export function sessionBackupPrimaryName(name: string): string | undefined {
	if (!isSessionBackupName(name)) return undefined;
	const withoutSuffix = name.slice(0, -SESSION_BACKUP_EXTENSION.length);
	const idStart = withoutSuffix.lastIndexOf(".");
	if (idStart <= 0) return undefined;
	const primary = withoutSuffix.slice(0, idStart);
	if (withoutSuffix.length - idStart <= 1) return undefined;
	return isSessionFileName(primary) ? primary : undefined;
}

export const ADVISOR_TRANSCRIPT_STEM = "__advisor";

export const ADVISOR_TRANSCRIPT_FILENAME = sessionFileName(ADVISOR_TRANSCRIPT_STEM);

export const ADVISOR_TRANSCRIPT_PREFIX = `${ADVISOR_TRANSCRIPT_STEM}.`;

export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME || (name.startsWith(ADVISOR_TRANSCRIPT_PREFIX) && isSessionFileName(name))
	);
}

export function advisorTranscriptSlug(name: string): string {
	return name === ADVISOR_TRANSCRIPT_FILENAME ? "" : sessionFileStem(name).slice(ADVISOR_TRANSCRIPT_PREFIX.length);
}
