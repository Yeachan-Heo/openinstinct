import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./env-file.ts";
import { linkHostModelsYml } from "./gjc-home.ts";
import { dataPaths } from "./paths.ts";

/** Evaluated before any SDK module; see main.ts. */
const paths = dataPaths();
export const ENV_FILE = loadEnvFile(paths.envFile);
// The SDK and every gjc child read state from this directory. Isolating it
// from the host's ~/.gjc means a host `gjc` upgrade can never migrate the
// session/auth schema out from under the version-locked SDK.
process.env.GJC_CODING_AGENT_DIR ??= paths.gjcHome;

/**
 * Settings the SDK reads from `<gjcHome>/config.yml`. Owned by the daemon:
 * every key here is load-bearing. Discovery stays on (turning it off costs
 * ~60k tokens of tool schemas per turn vs ~10k), but `browser` is promoted
 * to an always-loaded essential so children never have to search for it.
 */
const REQUIRED_SDK_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["interruptMode", "interruptMode: wait"],
  ["steeringMode", "steeringMode: all"],
  ["compaction", "compaction:\n  enabled: false"],
  ["tools", "tools:\n  discoveryMode: all\n  essentialOverride: [read, bash, edit, write, search, find, browser]"],
  ["browser", "browser:\n  enabled: true\n  headless: true"],
];
{
  mkdirSync(paths.gjcHome, { recursive: true, mode: 0o700 });
  const file = join(paths.gjcHome, "config.yml");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "configSchemaVersion: 1\n";
  const missing = REQUIRED_SDK_SETTINGS.filter(([key]) => !new RegExp(`^${key}:`, "m").test(text));
  if (missing.length > 0) {
    text = `${text.replace(/\n*$/, "\n")}${missing.map(([, block]) => block).join("\n")}\n`;
    writeFileSync(file, text, { mode: 0o600 });
  }
  // Sessions/auth stay isolated; provider config is the owner's and is shared.
  linkHostModelsYml(paths.gjcHome, join(paths.home, ".gjc", "agent"));
}
