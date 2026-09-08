import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * `models.yml` is owner-authored provider config, not migrated SDK state, so
 * the isolated gjc home must not keep a private copy: the owner edits
 * `~/.gjc/agent/models.yml` and expects the panel to see it. This links the
 * isolated file to the host's, replacing a stale snapshot from an earlier
 * install (kept as `models.yml.bak` in case it held panel-added providers).
 *
 * Returns the state the link ended up in.
 */
export function linkHostModelsYml(gjcHome: string, hostAgentDir: string): "linked" | "already_linked" | "no_host_file" {
  const host = join(hostAgentDir, "models.yml");
  if (!existsSync(host)) {
    return "no_host_file";
  }
  const own = join(gjcHome, "models.yml");
  const stat = lstatSync(own, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    if (readlinkSync(own) === host) {
      return "already_linked";
    }
    unlinkSync(own);
  } else if (stat !== undefined) {
    const backup = `${own}.bak`;
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(own, backup);
  }
  symlinkSync(host, own);
  return "linked";
}
