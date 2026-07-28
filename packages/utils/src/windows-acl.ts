import { spawn } from "node:child_process";
import * as path from "node:path";
import { escapeTerminalText } from "./terminal-safe";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const WINDOWS_ACL_TIMEOUT_MS = 15_000;

export interface WindowsAclCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable only so ACL behavior can be exercised on non-Windows test hosts. */
export type WindowsAclCommandRunner = (
	script: string,
	filePath: string,
) => Promise<WindowsAclCommandResult>;

export interface WindowsAclOptions {
	platform?: NodeJS.Platform;
	run?: WindowsAclCommandRunner;
}

const VERIFY_ACL = String.raw`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier])
if (-not $owner.Equals($identity)) { throw 'ACL owner is not the current user' }
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is enabled' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'ACL does not contain exactly one access rule' }
$rule = $rules[0]
if (-not $rule.IdentityReference.Equals($identity)) { throw 'ACL grants another identity access' }
if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL owner rule is not an allow rule' }
if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL owner lacks full control' }
`;

const APPLY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($item.PSIsContainer) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object Security.AccessControl.FileSecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $identity,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl -ErrorAction Stop
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

const VERIFY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

/** Apply a protected DACL granting access exclusively to the current Windows user. */
export async function applyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(APPLY_SCRIPT, filePath, options);
}

/** Verify that a path has a protected owner-only DACL; rejects on any ambiguity. */
export async function verifyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(VERIFY_SCRIPT, filePath, options);
}

async function runOwnerOnlyAcl(script: string, filePath: string, options: WindowsAclOptions): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return;
	if (filePath.length === 0 || filePath.includes("\0")) throw new Error("The Windows ACL path is invalid.");

	const result = await (options.run ?? defaultWindowsAclRunner)(script, filePath);
	if (result.exitCode !== 0 || result.stdout !== "OK") {
		const detail = boundedDiagnostic(result.stderr || result.stdout || `exit code ${result.exitCode}`);
		throw new Error(`The owner-only Windows ACL operation failed (${detail}).`);
	}
}

async function defaultWindowsAclRunner(script: string, filePath: string): Promise<WindowsAclCommandResult> {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
		throw new Error("A trusted absolute Windows system root is unavailable.");
	}
	const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return await new Promise<WindowsAclCommandResult>((resolve, reject) => {
		const child = spawn(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{
				env: { SystemRoot: systemRoot, VEYYON_OWNER_ONLY_ACL_PATH: filePath },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let totalBytes = 0;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		const collect = (destination: Buffer[], chunk: Buffer): void => {
			if (settled) return;
			totalBytes += chunk.length;
			if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
				child.kill();
				fail(new Error("The Windows ACL command produced excessive output."));
				return;
			}
			destination.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.once("error", error => fail(error));
		child.once("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8").trim(),
				stderr: Buffer.concat(stderr).toString("utf8").trim(),
			});
		});
		timer = setTimeout(() => {
			child.kill();
			fail(new Error("The Windows ACL command timed out."));
		}, WINDOWS_ACL_TIMEOUT_MS);
	});
}

function boundedDiagnostic(value: string): string {
	const inert = escapeTerminalText(value);
	return inert.length <= 512 ? inert : `${inert.slice(0, 511)}…`;
}
