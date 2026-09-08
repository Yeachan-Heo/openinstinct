import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSoul } from "../src/persona/soul.ts";

describe("gajae soul", () => {
  test("ships versioned, non-empty, and strips the version comment", () => {
    const soul = loadSoul();
    expect(soul.version).toMatch(/^\d+$/);
    expect(soul.text.startsWith("# SOUL.md")).toBe(true);
    expect(soul.text).not.toContain("{{");
    expect(soul.text).not.toContain("soul-version");
    expect(soul.text).toMatch(/fake completion/);
  });

  test("reads the version from the file so an edit is reflected on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "openinstinct-soul-"));
    const path = join(dir, "SOUL.md");
    writeFileSync(path, "<!-- soul-version: 7 -->\nYou are Gajae v7.");
    expect(loadSoul(path)).toEqual({ version: "7", text: "You are Gajae v7." });
  });
});

import { loadRuntimeBlock } from "../src/persona/soul.ts";
describe("runtime block", () => {
  test("renders a detached chat-only runtime without unreplaced lane placeholders", () => {
    const block = loadRuntimeBlock({ imessage: "detached", ownerName: "Ada", chromeProfile: "/x/chrome" });
    expect(block.version).toBe("14");
    expect(block.text).toContain("The owner is Ada.");
    expect(block.text).toContain("(no iMessage number configured)");
    expect(block.text).toContain("not connected right now");
    expect(block.text).toContain("menu-bar Chat window");
    expect(block.text).toContain("Both owner-facing surfaces render plain text only");
    expect(block.text).toContain("MainSession and the authenticated host routing path");
    expect(block.text).toContain("child_nudge");
    expect(block.text).toContain("never send iMessage directly");
    expect(block.text).not.toContain("{{ownerHandle}}");
    expect(block.text).not.toContain("{{imessageState}}");
    expect(block.text).not.toContain("{{");
    expect(block.text).toContain('user_data_dir: "/x/chrome"');
    expect(block.text).toContain("child_status");
    expect(block.text).toContain("progress updates");
    expect(loadRuntimeBlock({ imessage: "detached", ownerName: "", chromeProfile: "/x" }).text).toContain("The owner is the owner.");
  });

  test("renders the configured handle and connected lane state", () => {
    const block = loadRuntimeBlock({ ownerHandle: "+15550001111", imessage: "attached", ownerName: "Ada", chromeProfile: "/x/chrome" });
    expect(block.version).toBe("14");
    expect(block.text).toContain("over iMessage at +15550001111");
    expect(block.text).toContain("iMessage is connected");
    expect(block.text).not.toContain("{{");
    expect(loadRuntimeBlock({ ownerHandle: "+1", imessage: "attached", ownerName: "", chromeProfile: "/x" }).text).toContain("over iMessage at +1");
  });
});

import { mkdirSync as mkd, writeFileSync as wf } from "node:fs";
import { buildOrientation, ORIENTATION_HEAD } from "../src/persona/orientation.ts";
describe("orientation", () => {
  test("bundles soul version, memory index and today's notes, bounded, and tells the model to stay quiet about it", () => {
    const root = mkdtempSync(join(tmpdir(), "oi-orient-"));
    mkd(join(root, "daily"), { recursive: true });
    wf(join(root, "MEMORY.md"), "# Index\n- people/owner.md");
    wf(join(root, "daily", "2026-09-02.md"), "- 22:00 저녁약 알림 보냄\n- 호진 DM 로스트 모니터 생성");
    const text = buildOrientation(root, new Date("2026-09-02T13:00:00Z"));
    expect(text.startsWith(ORIENTATION_HEAD)).toBe(true);
    expect(text).toMatch(/re-read your SOUL/);
    expect(text).toContain("people/owner.md");
    expect(text).toContain("호진 DM 로스트");
    expect(text).toMatch(/Do not mention this reset/);
    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(buildOrientation(join(root, "nope"))).toMatch(/re-read your SOUL/);
  });
});
