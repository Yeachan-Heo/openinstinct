import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { normalizeHandle } from "../imessage/allowlist.ts";
import { loadSoul } from "../persona/soul.ts";
import type { DataPaths } from "../paths.ts";
import {
  DEFAULT_CHILD_IDLE_TIMEOUT_MS,
  DEFAULT_CHILD_INTERIM_BATCH_MS,
  DEFAULT_CHILD_INTERIM_MAX_BYTES,
  DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
  DEFAULT_CHILD_STATUS_LIST_LIMIT,
  DEFAULT_CHILD_STATUS_TEXT_BYTES,
  DEFAULT_CHILD_TOOL_GUARD_MS,
  DEFAULT_CHILD_WARM_TTL_MS,
  DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS,
  DEFAULT_DAEMON_CHILD_TIMEOUT_MS,
  DEFAULT_MAIN_SESSION_MODEL,
  DEFAULT_MAIN_TURN_WATCHDOG_MS,
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  DEFAULT_MAX_LIVE_CHILDREN,
  readRuntimeConfig,
} from "../runtime-config.ts";
import { validateCron } from "../monitors/store.ts";
import { adoptCredential as adoptExternalCredential, discoverCredentials as discoverExternalCredentials } from "./credential-adopt.ts";
import type { DiscoveredCredential } from "./credential-adopt.ts";
import { parseEnvFile, writeEnvFile } from "./env.ts";

/** Which keys the panel may read (as set/unset) and write in ~/.openinstinct/env. */
export const MANAGED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENGATEWAY_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "PUPPETEER_EXECUTABLE_PATH",
] as const;

export const MANAGED_CREDENTIAL_ENV_KEYS: readonly string[] = MANAGED_ENV_KEYS.filter(
  (key) => key.endsWith("_API_KEY") || key === "ANTHROPIC_OAUTH_TOKEN",
);
export const OI_API_KEY_PATTERN = /^OI_[A-Z0-9_]+_API_KEY$/;
export const MANAGED_OI_API_KEY_PATTERN = OI_API_KEY_PATTERN;
/** `gjc --list-models` is slow (~seconds); serve it cached and refresh in the background once it is this old. */
export const MODELS_TTL_MS = 10 * 60_000;

interface CacheEntry {
  at: number;
  value: unknown;
  inflight?: Promise<unknown>;
}

export interface SettingsSnapshot {
  readonly ownerHandle: string;
  readonly ownerName: string;
  readonly mainSessionModel: string;
  readonly fastMode: boolean;
  readonly mainTurnWatchdogSec: number;
  readonly childMaxConcurrent: number;
  readonly childConversationalTimeoutSec: number;
  readonly childDaemonTimeoutSec: number;
  readonly childWarmTtlSec: number;
  readonly childIdleTimeoutSec: number;
  readonly childMaxLive: number;
  readonly childInterimBatchSec: number;
  readonly childInterimRatePerMinute: number;
  readonly childInterimMaxBytes: number;
  readonly childStatusListLimit: number;
  readonly childStatusTextBytes: number;
  readonly childToolGuardMs: number;
  readonly env: readonly { readonly key: string; readonly set: boolean }[];
  readonly soulVersion: string;
  readonly soulText: string;
  readonly configPath: string;
}

export interface SettingsPatch {
  readonly ownerHandle?: string;
  readonly ownerName?: string;
  readonly mainSessionModel?: string;
  readonly fastMode?: boolean;
  readonly mainTurnWatchdogSec?: number;
  readonly childMaxConcurrent?: number;
  readonly childConversationalTimeoutSec?: number;
  readonly childDaemonTimeoutSec?: number;
  readonly childWarmTtlSec?: number;
  readonly childIdleTimeoutSec?: number;
  readonly childMaxLive?: number;
  readonly childInterimBatchSec?: number;
  readonly childInterimRatePerMinute?: number;
  readonly childInterimMaxBytes?: number;
  readonly childStatusListLimit?: number;
  readonly childStatusTextBytes?: number;
  readonly childToolGuardMs?: number;
  /** Empty string unsets. */
  readonly env?: Readonly<Record<string, string>>;
  readonly soulText?: string;
}

export interface ModelChoice {
  readonly id: string;
  readonly provider: string;
  readonly canonical: string;
}

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly identity: string | null;
  readonly health: string;
}

export interface SettingsServiceOptions {
  readonly paths: DataPaths;
  readonly soulPath: string;
  readonly gjcBinary?: string;
}

/**
 * Every owner-tunable surface behind one door so the panel can edit it. Writes
 * are validated with the same parsers the daemon boots with, so a bad value is
 * rejected here instead of taking the daemon down on the next restart.
 */
export class SettingsService {
  private pendingLogin: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  private pendingProvider: string | undefined;

  public constructor(private readonly options: SettingsServiceOptions) {}

  public async snapshot(): Promise<SettingsSnapshot> {
    const raw = this.readConfigRaw();
    const config = await readRuntimeConfig(this.options.paths.config).catch(() => undefined);
    const soul = loadSoul(this.options.soulPath);
    const env = parseEnvFile(this.options.paths.envFile);
    return {
      ownerHandle: config?.allowlistHandle ?? (typeof raw.allowlistHandle === "string" ? raw.allowlistHandle : ""),
      ownerName: typeof raw.ownerName === "string" ? raw.ownerName : "",
      mainSessionModel: config?.mainSessionModel ?? DEFAULT_MAIN_SESSION_MODEL,
      fastMode: await this.fastModeEnabled(),
      mainTurnWatchdogSec: Math.round((config?.mainTurnWatchdogMs ?? DEFAULT_MAIN_TURN_WATCHDOG_MS) / 1_000),
      childMaxConcurrent: config?.children.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHILDREN,
      childConversationalTimeoutSec: Math.round((config?.children.conversationalTimeoutMs ?? DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS) / 1_000),
      childDaemonTimeoutSec: Math.round((config?.children.daemonTimeoutMs ?? DEFAULT_DAEMON_CHILD_TIMEOUT_MS) / 1_000),
      childWarmTtlSec: Math.round((config?.children.warmTtlMs ?? DEFAULT_CHILD_WARM_TTL_MS) / 1_000),
      childIdleTimeoutSec: Math.round((config?.children.idleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS) / 1_000),
      childMaxLive: config?.children.maxLive ?? DEFAULT_MAX_LIVE_CHILDREN,
      childInterimBatchSec: Math.round((config?.children.interimBatchMs ?? DEFAULT_CHILD_INTERIM_BATCH_MS) / 1_000),
      childInterimRatePerMinute: config?.children.interimRatePerMinute ?? DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
      childInterimMaxBytes: config?.children.interimMaxBytes ?? DEFAULT_CHILD_INTERIM_MAX_BYTES,
      childStatusListLimit: config?.children.statusListLimit ?? DEFAULT_CHILD_STATUS_LIST_LIMIT,
      childStatusTextBytes: config?.children.statusTextMaxBytes ?? DEFAULT_CHILD_STATUS_TEXT_BYTES,
      childToolGuardMs: config?.children.toolLatencyGuardMs ?? DEFAULT_CHILD_TOOL_GUARD_MS,
      env: MANAGED_ENV_KEYS.map((key) => ({ key, set: env.has(key) && (env.get(key) ?? "").length > 0 })),
      soulVersion: soul.version,
      soulText: soul.text,
      configPath: this.options.paths.config,
    };
  }

  /** Returns which restart-scoped things changed so the caller can reload/restart. */
  public async apply(patch: SettingsPatch): Promise<{
    readonly needsRestart: boolean;
    readonly needsReload: boolean;
    readonly ownerHandleChanged: boolean;
  }> {
    let needsRestart = false;
    let needsReload = false;
    let fastModeChange: boolean | undefined;
    let ownerHandleChanged = false;
    const raw = this.readConfigRaw();

    if (patch.ownerHandle !== undefined) {
      if (patch.ownerHandle.length === 0) {
        delete raw.allowlistHandle;
      } else {
        const normalized = normalizeHandle(patch.ownerHandle);
        if (!normalized) {
          throw new Error("Owner handle must be a phone number with country code or an email");
        }
        raw.allowlistHandle = normalized;
      }
      needsReload = true;
      ownerHandleChanged = true;
    }
    if (patch.ownerName !== undefined) {
      raw.ownerName = patch.ownerName.trim();
      needsReload = true;
    }
    if (patch.mainSessionModel !== undefined) {
      const model = patch.mainSessionModel.trim();
      if (!/^[a-z0-9-]+\/[A-Za-z0-9._:/-]+$/.test(model)) {
        throw new Error("Model must look like provider/model-id");
      }
      raw.mainSessionModel = model;
      // Children runners capture the model at boot; a restart applies it everywhere.
      needsRestart = true;
    }
    if (patch.fastMode !== undefined) {
      fastModeChange = patch.fastMode;
      needsReload = true;
    }
    if (patch.mainTurnWatchdogSec !== undefined) {
      raw.mainTurnWatchdogMs = positiveSeconds(patch.mainTurnWatchdogSec, "Reply time limit") * 1_000;
      needsRestart = true;
    }
    const children = isRecord(raw.children) ? { ...raw.children } : {};
    if (patch.childMaxConcurrent !== undefined) {
      const n = patch.childMaxConcurrent;
      if (!Number.isSafeInteger(n) || n < 1 || n > 16) {
        throw new Error("Background tasks at once must be 1–16");
      }
      children.maxConcurrent = n;
      needsRestart = true;
    }
    if (patch.childConversationalTimeoutSec !== undefined) {
      children.conversationalTimeoutMs = positiveSeconds(patch.childConversationalTimeoutSec, "Background task time limit") * 1_000;
      needsRestart = true;
    }
    if (patch.childDaemonTimeoutSec !== undefined) {
      children.daemonTimeoutMs = positiveSeconds(patch.childDaemonTimeoutSec, "Scheduled task time limit") * 1_000;
      needsRestart = true;
    }
    if (patch.childWarmTtlSec !== undefined) {
      children.warmTtlMs = boundedInteger(
        patch.childWarmTtlSec,
        "Keep finished tasks warm",
        60,
        86_400,
        "between 60 seconds and 24 hours",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childIdleTimeoutSec !== undefined) {
      children.idleTimeoutMs = boundedInteger(
        patch.childIdleTimeoutSec,
        "Forget idle tasks",
        300,
        86_400,
        "between 300 seconds and 24 hours",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childMaxLive !== undefined) {
      children.maxLive = boundedInteger(patch.childMaxLive, "Live background tasks", 1, 64, "1–64");
      needsRestart = true;
    }
    if (patch.childInterimBatchSec !== undefined) {
      children.interimBatchMs = boundedInteger(
        patch.childInterimBatchSec,
        "Bundle task updates",
        1,
        60,
        "1–60 seconds",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childInterimRatePerMinute !== undefined) {
      children.interimRatePerMinute = boundedInteger(
        patch.childInterimRatePerMinute,
        "Updates per task per minute",
        1,
        60,
        "1–60",
      );
      needsRestart = true;
    }
    if (patch.childInterimMaxBytes !== undefined) {
      children.interimMaxBytes = boundedInteger(
        patch.childInterimMaxBytes,
        "Progress update size",
        128,
        8_192,
        "128–8192 bytes",
      );
      needsRestart = true;
    }
    if (patch.childStatusListLimit !== undefined) {
      children.statusListLimit = boundedInteger(
        patch.childStatusListLimit,
        "Background task status list limit",
        1,
        100,
        "1–100",
      );
      needsRestart = true;
    }
    if (patch.childStatusTextBytes !== undefined) {
      children.statusTextMaxBytes = boundedInteger(
        patch.childStatusTextBytes,
        "Background task status text",
        128,
        8_192,
        "128–8192 bytes",
      );
      needsRestart = true;
    }
    if (patch.childToolGuardMs !== undefined) {
      children.toolLatencyGuardMs = boundedInteger(
        patch.childToolGuardMs,
        "Background task latency alert threshold",
        5,
        1_000,
        "5–1000 ms",
      );
      needsRestart = true;
    }
    const maxConcurrent = childIntegerOrDefault(children.maxConcurrent, DEFAULT_MAX_CONCURRENT_CHILDREN);
    const maxLive = childIntegerOrDefault(children.maxLive, DEFAULT_MAX_LIVE_CHILDREN);
    if (maxLive < maxConcurrent) {
      throw new Error("Live background tasks must be greater than or equal to background tasks at once");
    }
    if (Object.keys(children).length > 0) {
      raw.children = children;
    }

    if (patch.env !== undefined) {
      const env = parseEnvFile(this.options.paths.envFile);
      let credentialEnvTouched = false;
      for (const [key, value] of Object.entries(patch.env)) {
        if (!(MANAGED_ENV_KEYS as readonly string[]).includes(key) && !OI_API_KEY_PATTERN.test(key)) {
          throw new Error(`${key} is not a managed setting`);
        }
        if (MANAGED_CREDENTIAL_ENV_KEYS.includes(key) || OI_API_KEY_PATTERN.test(key)) {
          credentialEnvTouched = true;
        }
        if (value.length === 0) {
          env.delete(key);
        } else if (/[\r\n]/.test(value)) {
          throw new Error(`${key} must be a single line`);
        } else {
          env.set(key, value);
        }
      }
      writeEnvFile(this.options.paths.envFile, env);
      if (credentialEnvTouched) {
        this.invalidate("accounts");
      }
      needsRestart = true;
    }

    if (patch.soulText !== undefined) {
      const text = patch.soulText.trim();
      if (text.length < 40) {
        throw new Error("Personality text is too short to be a personality");
      }
      const current = loadSoul(this.options.soulPath);
      const next = Number.isSafeInteger(Number(current.version)) ? String(Number(current.version) + 1) : "1";
      writeFileSync(this.options.soulPath, `<!-- soul-version: ${next} -->\n${text}\n`);
      needsReload = true;
    }

    // Validate the whole file with the boot parser before committing it.
    const draft = `${this.options.paths.config}.draft`;
    writeFileSync(draft, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    try {
      await readRuntimeConfig(draft);
    } catch (error) {
      throw new Error(`Settings rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    if (fastModeChange !== undefined) {
      await this.setFastMode(fastModeChange);
    }
    return { needsRestart, needsReload, ownerHandleChanged };
  }


  /** Persists provider priority off after the SDK reports a fast-mode rejection. */
  public async disableFastMode(): Promise<void> {
    await this.setFastMode(false);
  }

  private async fastModeEnabled(): Promise<boolean> {
    const value = await this.gjc(["config", "get", "serviceTier"], 10_000).catch(() => "none");
    return value.trim() === "priority";
  }

  private async setFastMode(enabled: boolean): Promise<void> {
    await this.gjc(["config", "set", "serviceTier", enabled ? "priority" : "none"], 10_000);
  }
  /**
   * After a sign-in, pick a sensible main model for that provider unless the
   * owner already chose one explicitly. Public model ids only.
   */
  public async defaultModelFor(provider: string): Promise<string | undefined> {
    const raw = this.readConfigRaw();
    if (typeof raw.mainSessionModel === "string") {
      return undefined;
    }
    const preferred: Record<string, string> = {
      "anthropic": "anthropic/claude-sonnet-4-5",
      "openai-codex": "openai-codex/gpt-5",
      "openai": "openai/gpt-5",
    };
    const wanted = preferred[provider];
    if (!wanted) {
      return undefined;
    }
    const available = await this.listModels().catch(() => []);
    const hit = available.find((m) => m.id === wanted) ?? available.find((m) => m.provider === provider);
    if (!hit) {
      return undefined;
    }
    raw.mainSessionModel = hit.id;
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    return hit.id;
  }

  /** OAuth providers gjc knows, popular ones first. Pulled from the CLI so new ones appear without a daemon change. */
  private async listOAuthProvidersUncached(): Promise<{ readonly id: string; readonly label: string; readonly popular: boolean }[]> {
    const popular: [string, string][] = [
      ["anthropic", "Claude (Anthropic)"],
      ["openai-codex", "ChatGPT / Codex (OpenAI)"],
      ["opengateway", "OpenGateway"],
      ["commandcode-goat", "CommandCode GOAT"],
      ["opencode-go", "OpenCode Go"],
      ["google-antigravity", "Google Antigravity"],
      ["openrouter", "OpenRouter"],
      ["xai", "xAI Grok"],
      ["deepseek", "DeepSeek"],
      ["glm-zcode", "Z.ai GLM"],
      ["kimi-code", "Kimi (Moonshot)"],
      ["minimax-code", "MiniMax"],
    ];
    let known: string[] = [];
    try {
      const child = Bun.spawn([this.binary(), "auth-broker", "login", "__list__"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: this.options.paths.home } });
      const err = await new Response(child.stderr).text();
      await child.exited;
      const m = /Known:\s*([a-z0-9-,\s]+)/i.exec(err);
      known = m ? m[1]!.split(",").map((x) => x.trim()).filter(Boolean) : [];
    } catch {
      known = [];
    }
    const set = new Set(known.length > 0 ? known : popular.map(([id]) => id));
    const out: { id: string; label: string; popular: boolean }[] = [];
    for (const [id, label] of popular) {
      if (set.has(id)) { out.push({ id, label, popular: true }); set.delete(id); }
    }
    for (const id of [...set].sort()) {
      out.push({ id, label: id, popular: false });
    }
    return out;
  }

  /**
   * Registers a custom OpenAI/Anthropic-compatible endpoint as a gjc provider
   * in models.yml (the isolated gjc home's copy is a symlink to the host's
   * ~/.gjc/agent/models.yml, so the write lands there), stores its key in the
   * env file, and selects `<id>/<model>` as the main model.
   */
  public async addCustomProvider(input: { readonly id: string; readonly baseUrl: string; readonly api: "openai-responses" | "openai-completions" | "anthropic-messages"; readonly apiKey: string; readonly model: string }): Promise<{ readonly modelId: string }> {
    const id = input.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("Provider name: letters, digits, dashes (e.g. my-gateway)");
    if (!/^https?:\/\/\S+$/.test(input.baseUrl.trim())) throw new Error("Base URL must start with http:// or https://");
    if (!/^[A-Za-z0-9._:-]+$/.test(input.model.trim())) throw new Error("Model id looks wrong");
    if (input.apiKey.trim().length === 0) throw new Error("API key is required");
    const envKey = `OI_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    const env = parseEnvFile(this.options.paths.envFile);
    env.set(envKey, input.apiKey.trim());
    writeEnvFile(this.options.paths.envFile, env);
    const yamlPath = join(this.options.paths.gjcHome, "models.yml");
    mkdirSync(dirname(yamlPath), { recursive: true });
    let yaml = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : "providers:\n";
    if (!/^providers:\s*$/m.test(yaml)) yaml = `providers:\n${yaml}`;
    // Replace an existing block with the same id (top-level 2-space key) or append.
    const blockRe = new RegExp(`^  ${id}:\\s*\\n(?:^(?:    .*|\\s*)\\n)*`, "m");
    const block = [
      `  ${id}:`,
      `    baseUrl: ${input.baseUrl.trim().replace(/\/+$/, "")}`,
      `    apiKeyEnv: ${envKey}`,
      `    api: ${input.api}`,
      `    auth: apiKey`,
      `    models:`,
      `      - id: ${input.model.trim()}`,
      `        name: ${input.model.trim()} via ${id}`,
      "",
    ].join("\n");
    yaml = blockRe.test(yaml) ? yaml.replace(blockRe, block) : yaml.replace(/^providers:\s*\n/m, `providers:\n${block}`);
    writeFileSync(yamlPath, yaml);
    this.invalidate("models");
    this.invalidate("accounts");

    const modelId = `${id}/${input.model.trim()}`;
    const raw = this.readConfigRaw();
    raw.mainSessionModel = modelId;
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    return { modelId };
  }

  private cache = new Map<string, CacheEntry>();

  /**
   * Serve the last result instantly and refresh in the background once it is
   * older than `ttlMs`. `force` drops the cached value and awaits a fresh load;
   * callers arriving while that load is in flight share its result. A failed
   * load never poisons the key: first-load failures are evicted so the next
   * caller retries, and background-refresh failures keep serving the last good
   * value until the next attempt.
   */
  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>, force = false): Promise<T> {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      const record: CacheEntry = { at: 0, value: undefined };
      record.inflight = load().then(
        (value) => { record.at = Date.now(); record.value = value; record.inflight = undefined; return value; },
        (error: unknown) => { if (this.cache.get(key) === record) this.cache.delete(key); throw error; },
      );
      this.cache.set(key, record);
      return record.inflight as Promise<T>;
    }
    if (entry.inflight === undefined && (force || Date.now() - entry.at >= ttlMs)) {
      entry.inflight = load()
        .then((value) => { entry.at = Date.now(); entry.value = value; return value; })
        .finally(() => { entry.inflight = undefined; });
      if (!force) entry.inflight.catch(() => undefined);
    }
    if (entry.inflight !== undefined && (force || entry.at === 0)) {
      return entry.inflight as Promise<T>;
    }
    return Promise.resolve(entry.value as T);
  }

  /** Warm the slow gjc-backed lists so the panel opens instantly. */
  public warm(): void {
    void this.listModels().catch(() => undefined);
    void this.listOAuthProviders().catch(() => undefined);
    void this.listAccounts().catch(() => undefined);
  }

  public listModels(options: { readonly refresh?: boolean } = {}): Promise<ModelChoice[]> {
    return this.cached("models", MODELS_TTL_MS, () => this.listModelsUncached(), options.refresh === true);
  }

  public listAccounts(): Promise<AccountRow[]> {
    return this.cached("accounts", 60_000, () => this.listAccountsUncached());
  }

  public discoverCredentials(): Promise<{ readonly credentials: readonly DiscoveredCredential[] }> {
    return discoverExternalCredentials().then((credentials) => ({ credentials }));
  }

  public async adoptCredential(id: string): Promise<{ readonly adopted: boolean; readonly provider: string; readonly restarting: boolean }> {
    const { provider } = await adoptExternalCredential(id);
    return { adopted: true, provider, restarting: true };
  }

  public listOAuthProviders(): Promise<{ readonly id: string; readonly label: string; readonly popular: boolean }[]> {
    return this.cached("providers", 60 * 60_000, () => this.listOAuthProvidersUncached());
  }

  public invalidate(key?: string): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }

  private async listModelsUncached(): Promise<ModelChoice[]> {
    const result = await this.gjc(["--list-models"], 30_000);
    // The "Canonical models" table shows one selected variant per canonical
    // name; the "Provider models" table below it lists every provider×model
    // pair (all of models.yml). Parse the latter, keep canonical as an alias.
    const models = new Map<string, ModelChoice>();
    let section: "canonical" | "provider" | undefined;
    for (const line of result.split("\n")) {
      if (/^Canonical models/.test(line)) { section = "canonical"; continue; }
      if (/^Provider models/.test(line)) { section = "provider"; continue; }
      if (section === "provider") {
        const m = /^(\S+)\s+(\S+)\s+/.exec(line);
        if (!m || m[1] === "provider") continue;
        const id = `${m[1]}/${m[2]}`;
        if (!models.has(id)) models.set(id, { canonical: m[2]!, provider: m[1]!, id });
      } else if (section === "canonical") {
        const m = /^(\S+)\s+(\S+)\/(\S+)\s+/.exec(line);
        if (!m || m[1] === "canonical") continue;
        const id = `${m[2]}/${m[3]}`;
        const existing = models.get(id);
        models.set(id, { canonical: m[1]!, provider: m[2]!, id, ...(existing ? {} : {}) });
      }
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }


  private async listAccountsUncached(): Promise<AccountRow[]> {
    const raw = await this.gjc(["accounts", "list", "--json"], 30_000);
    const parsed = JSON.parse(raw) as { readonly accounts?: readonly Record<string, unknown>[] };
    return (parsed.accounts ?? []).map((a) => ({
      id: String(a.id),
      provider: String(a.provider),
      kind: String(a.credentialKind),
      identity: typeof a.identityLabel === "string" ? a.identityLabel : null,
      health: isRecord(a.health) && typeof a.health.status === "string" ? a.health.status : "unknown",
    }));
  }

  /**
   * Starts the same OAuth flow as the gjc TUI's /login. The CLI prints the
   * authorization URL then waits for the browser callback on localhost; we
   * hand the URL to the panel (which opens it) and let the CLI finish in the
   * background. The daemon never sees the tokens: they land in ~/.gjc auth.db.
   */
  public async startLogin(provider: string): Promise<{ readonly url: string; readonly manual: boolean }> {
    if (!/^[a-z0-9-]+$/.test(provider)) {
      throw new Error("bad provider id");
    }
    this.pendingLogin?.kill();
    // stdin must stay open: the CLI holds a readline prompt while it waits for
    // the localhost callback (and accepts a pasted code there as fallback).
    const child = Bun.spawn([this.binary(), "auth-broker", "login", provider], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: this.options.paths.home, GJC_CODING_AGENT_DIR: this.options.paths.gjcHome },
    });
    this.pendingLogin = child;
    this.pendingProvider = provider;
    void child.exited.then(() => { if (this.pendingLogin === child) { this.pendingLogin = undefined; } });
    // The CLI prints the URL to stdout (sometimes stderr), fully buffered
    // when piped; drain both streams continuously and match on any https URL.
    let buffer = "";
    const decoder = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    void drain(child.stdout);
    void drain(child.stderr);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const url = /https:\/\/[^\s"'<>]+/.exec(buffer)?.[0];
      if (url) {
        return { url, manual: true };
      }
      if (child.exitCode !== null) {
        break;
      }
      await Bun.sleep(200);
    }
    child.kill();
    throw new Error(`gjc did not print a login URL for ${provider}`);
  }

  /** Completes a login by pasting the redirect URL / code into the waiting CLI. */
  public async finishLogin(codeOrUrl: string): Promise<void> {
    const child = this.pendingLogin;
    if (!child) {
      throw new Error("no login in progress");
    }
    const stdin = child.stdin;
    if (typeof stdin !== "object" || stdin === null) {
      throw new Error("login process has no stdin");
    }
    stdin.write(`${codeOrUrl.trim()}\n`);
    await stdin.flush();
    const code = await Promise.race([child.exited, Bun.sleep(60_000).then(() => -1)]);
    if (code !== 0) {
      child.kill();
      throw new Error(code === -1 ? "login did not complete in time" : "login failed; try again");
    }
    this.invalidate("accounts");

    if (this.pendingProvider) {
      await this.defaultModelFor(this.pendingProvider);
    }
  }

  public async logout(provider: string, account: string): Promise<void> {
    await this.gjc(["accounts", "logout", provider, "--account", account], 30_000);
    this.invalidate("accounts");
  }

  private readConfigRaw(): Record<string, unknown> {
    if (!existsSync(this.options.paths.config)) {
      return {};
    }
    const parsed: unknown = JSON.parse(readFileSync(this.options.paths.config, "utf8"));
    return isRecord(parsed) ? { ...parsed } : {};
  }

  private binary(): string {
    return this.options.gjcBinary ?? this.options.paths.gjcBinary;
  }

  private async gjc(argv: readonly string[], timeoutMs: number): Promise<string> {
    const child = Bun.spawn([this.binary(), ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: this.options.paths.home, GJC_CODING_AGENT_DIR: this.options.paths.gjcHome },
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) {
        throw new Error(`gjc ${argv[0]} failed: ${(err || out).trim().slice(0, 300)}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}


function positiveSeconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 5 || value > 86_400) {
    throw new Error(`${label} must be between 5 seconds and 24 hours`);
  }
  return Math.round(value);
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
  range: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be ${range}`);
  }
  return value;
}

function childIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Re-exported so the panel's cron helper can validate before authoring.
export { validateCron };
