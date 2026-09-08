import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkHostModelsYml } from "../src/gjc-home.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function make(): { gjcHome: string; hostAgent: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-gjc-home-")); dirs.push(root);
  const gjcHome = join(root, "gjc"); mkdirSync(gjcHome);
  const hostAgent = join(root, ".gjc", "agent"); mkdirSync(hostAgent, { recursive: true });
  return { gjcHome, hostAgent };
}

describe("linkHostModelsYml", () => {
  test("links the isolated models.yml to the host's and reads through it", () => {
    const { gjcHome, hostAgent } = make();
    writeFileSync(join(hostAgent, "models.yml"), "providers:\n  mine:\n");
    expect(linkHostModelsYml(gjcHome, hostAgent)).toBe("linked");
    expect(readlinkSync(join(gjcHome, "models.yml"))).toBe(join(hostAgent, "models.yml"));
    expect(readFileSync(join(gjcHome, "models.yml"), "utf8")).toContain("mine:");
    expect(linkHostModelsYml(gjcHome, hostAgent)).toBe("already_linked");
  });

  test("replaces a stale snapshot, keeping it as models.yml.bak", () => {
    const { gjcHome, hostAgent } = make();
    writeFileSync(join(hostAgent, "models.yml"), "providers:\n  fresh:\n");
    writeFileSync(join(gjcHome, "models.yml"), "providers:\n  stale:\n");
    expect(linkHostModelsYml(gjcHome, hostAgent)).toBe("linked");
    expect(lstatSync(join(gjcHome, "models.yml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(gjcHome, "models.yml"), "utf8")).toContain("fresh:");
    expect(readFileSync(join(gjcHome, "models.yml.bak"), "utf8")).toContain("stale:");
  });

  test("writes through the link land in the host file", () => {
    const { gjcHome, hostAgent } = make();
    writeFileSync(join(hostAgent, "models.yml"), "providers:\n");
    linkHostModelsYml(gjcHome, hostAgent);
    writeFileSync(join(gjcHome, "models.yml"), "providers:\n  added:\n");
    expect(readFileSync(join(hostAgent, "models.yml"), "utf8")).toContain("added:");
    expect(lstatSync(join(gjcHome, "models.yml")).isSymbolicLink()).toBe(true);
  });

  test("leaves the isolated home alone when the host has no models.yml", () => {
    const { gjcHome, hostAgent } = make();
    writeFileSync(join(gjcHome, "models.yml"), "providers:\n  own:\n");
    expect(linkHostModelsYml(gjcHome, hostAgent)).toBe("no_host_file");
    expect(lstatSync(join(gjcHome, "models.yml")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(gjcHome, "models.yml.bak"))).toBe(false);
  });
});
