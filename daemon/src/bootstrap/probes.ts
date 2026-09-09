import { Database } from "bun:sqlite";

import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeHandle } from "../imessage/allowlist.ts";
import type { DataPaths } from "../paths.ts";
import { parseEnvFile } from "../settings/env.ts";
import { MANAGED_CREDENTIAL_ENV_KEYS, OI_API_KEY_PATTERN, type AccountRow } from "../settings/service.ts";
import type { BootstrapProbes, ProbeResult } from "./states.ts";

export type ConfigProbeResult = ProbeResult & { readonly allowlistHandle?: string };

export function createSystemProbes(
  paths: DataPaths,
  deps?: { readonly accounts: () => Promise<readonly AccountRow[]> },
): BootstrapProbes {
  const credentials = (): Promise<ProbeResult> => probeCredentials({
    envFile: paths.envFile,
    accounts: deps?.accounts ?? (async () => []),
  });

  return {
    config: () => probeConfig(paths.config),
    messages: () => probeMessagesIdentity(paths.config, readSelectedAliases),
    credentials,
    fda: () => probeFullDiskAccess(paths.home),
    accessibility: probeAccessibility,
  };
}

export async function probeMessagesIdentity(
  configPath: string,
  readAliases: () => readonly string[] | undefined,
): Promise<ProbeResult> {
  let owner: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (isRecord(parsed) && typeof parsed.allowlistHandle === "string") {
      owner = normalizeHandle(parsed.allowlistHandle);
    }
  } catch {
    // An unreadable config is handled by the config probe. This probe can still
    // report whether Messages is signed in, without comparing the owner handle.
  }

  let aliases: readonly string[] | undefined;
  try {
    aliases = readAliases();
  } catch {
    aliases = undefined;
  }
  if (aliases === undefined) {
    return { status: "unknown", reason: "Couldn't read which account Messages is signed in as." };
  }

  const filtered = aliases.filter((alias) => typeof alias === "string" && alias.trim().length > 0);
  if (filtered.length === 0) {
    return {
      status: "missing",
      reason: "Messages on this Mac isn't signed in to iMessage. Sign it in with Gajae's own Apple ID (not yours).",
    };
  }

  const ownerAlias = owner === undefined
    ? undefined
    : filtered.find((alias) => normalizeMessageAlias(alias) === owner);
  if (ownerAlias !== undefined) {
    return {
      status: "invalid",
      reason: `Messages on this Mac is signed in as you (${ownerAlias}). Gajae would reply inside your own conversations. Sign Messages out and back in with a separate Apple ID made for Gajae.`,
      aliases: filtered,
    };
  }
  return { status: "passed", aliases: filtered };
}

/**
 * Reads the current Messages identity from cfprefsd-backed preferences. Only
 * the alias dictionary is extracted: the full com.apple.madrid plist carries
 * <date>/<data> values that plutil refuses to render as JSON.
 */
export function readSelectedAliases(): readonly string[] | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    const exported = Bun.spawnSync(["/usr/bin/defaults", "export", "com.apple.madrid", "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (exported.exitCode !== 0) {
      return undefined;
    }
    const converted = Bun.spawnSync(["/usr/bin/plutil", "-extract", "IMD-IDS-Aliases", "json", "-o", "-", "-"], {
      stdin: exported.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (converted.exitCode !== 0) {
      return undefined;
    }

    const identity: unknown = JSON.parse(new TextDecoder().decode(converted.stdout));
    if (!isRecord(identity)) {
      return undefined;
    }
    const selected = identity.selectedAliases;
    const all = identity.allAliases;
    const aliases = Array.isArray(selected) ? selected : Array.isArray(all) ? all : undefined;
    if (aliases === undefined) {
      return undefined;
    }
    return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function normalizeMessageAlias(alias: string): string | undefined {
  // Messages commonly displays phone aliases with parentheses. Keep the
  // shared normalizer as the source of comparison semantics while accepting
  // that display-only punctuation.
  return normalizeHandle(alias) ?? normalizeHandle(alias.replace(/[()]/g, ""));
}

export async function probeConfig(path: string): Promise<ConfigProbeResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { status: "passed", reason: "config.json is missing; defaults apply" }
      : { status: "invalid", reason: "config.json cannot be read" };
  }

  try {
    const value: unknown = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return { status: "invalid", reason: "config.json must contain an object" };
    }

    const record = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "allowlistHandle")) {
      return { status: "passed" };
    }

    const allowlistHandle = typeof record.allowlistHandle === "string"
      ? normalizeHandle(record.allowlistHandle)
      : undefined;
    if (allowlistHandle === undefined) {
      return { status: "invalid", reason: "config.json must contain a valid allowlistHandle" };
    }
    return { status: "passed", allowlistHandle };
  } catch {
    return { status: "invalid", reason: "config.json is not valid JSON" };
  }
}

export function openChatDbReadonly(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    db.query("SELECT max(ROWID) FROM message").get();
  } finally {
    db.close();
  }
}

export async function probeFullDiskAccess(
  home: string,
  openReadonly: (path: string, flags: "r") => Promise<{ close(): Promise<void> }> = open,
): Promise<ProbeResult> {
  const path = join(home, "Library", "Messages", "chat.db");
  try {
    // Native open preserves errno; SQLite can collapse missing and denied into CANTOPEN.
    const file = await openReadonly(path, "r");
    await file.close();
    openChatDbReadonly(path);
    return { status: "passed" };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    const detail = `${code === undefined ? "" : `${code}: `}${error instanceof Error ? error.message : String(error)}`;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        status: "missing",
        reason: `Full Disk Access is unverified: the Messages database is unavailable. ${detail}`,
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        status: "denied",
        reason: `OS access to chat.db was denied; check file permissions and the installed daemon's Full Disk Access in System Settings. ${detail}`,
      };
    }
    return {
      status: "error",
      reason: `Full Disk Access check could not verify chat.db readability and schema. ${detail}`,
    };
  }
}

export async function probeCredentials(deps: {
  readonly envFile: string;
  readonly accounts: () => Promise<readonly AccountRow[]>;
}): Promise<ProbeResult> {
  const env = parseEnvFile(deps.envFile);
  const hasManagedCredential = MANAGED_CREDENTIAL_ENV_KEYS.some((key) => (env.get(key) ?? "").length > 0);
  const hasManagedOpenInstinctCredential = [...env.entries()].some(
    ([key, value]) => OI_API_KEY_PATTERN.test(key) && value.length > 0,
  );
  if (hasManagedCredential || hasManagedOpenInstinctCredential) {
    return { status: "passed" };
  }

  try {
    const accounts = await deps.accounts();
    return accounts.length > 0
      ? { status: "passed" }
      : { status: "missing", reason: "No AI account yet. Open Settings → AI account to sign in or paste an API key." };
  } catch {
    return { status: "unknown" };
  }
}

/** Reads the process's actual macOS Accessibility TCC decision through AX. */
export async function probeAccessibility(): Promise<ProbeResult> {
  if (process.platform !== "darwin") {
    return { status: "unknown", reason: "Automation probing is only available on macOS" };
  }
  // Sending goes through Messages' AppleScript bridge, so the permission that
  // matters is Automation (Apple events → Messages), not Accessibility. A
  // harmless query triggers the TCC prompt on first run and reports -1743
  // when denied.
  return accessibilityProbeResult(() => {
    const result = Bun.spawnSync(["/usr/bin/osascript", "-e", 'tell application "Messages" to get name'], { timeout: 15_000 });
    if (result.exitCode === 0) {
      return true;
    }
    const detail = result.stderr.toString();
    if (/-1743|not authori[sz]ed|not allowed/i.test(detail)) {
      return false;
    }
    throw new Error(detail.trim() || `osascript exited ${result.exitCode}`);
  });
}

export function accessibilityProbeResult(query: () => boolean): ProbeResult {
  try {
    return query()
      ? { status: "passed" }
      : { status: "denied", reason: "Gajae can't send texts yet: allow openinstinctd to control Messages under Automation." };
  } catch (error) {
    return { status: "error", reason: `Automation check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
