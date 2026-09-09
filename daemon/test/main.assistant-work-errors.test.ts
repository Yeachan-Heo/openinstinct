import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeManagedLocalFileAction } from "../src/assistant-work/execution.ts";
import { preflightLocalFileAction } from "../src/assistant-work/local-effects.ts";
import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitForLog(path: string, includes: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const entries = readFileSync(path, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = entries.find((candidate) => candidate.module === "assistant_work"
        && candidate.event === "runtime_failed" && candidate.level === "error"
        && typeof candidate.message === "string" && candidate.message.includes(includes));
      if (entry) return entry.message as string;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for durable assistant_work/runtime_failed containing ${includes}`);
}

test("daemon persists managed-work context and root evidence with bounded cyclic causes", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-main-work-errors-"));
  directories.push(root);
  const paths = dataPaths(join(root, "home"));
  const initial = openStateStore(paths.stateDb);
  const at = "2026-01-01T00:00:00.000Z";
  const path = join(root, "managed.txt");
  writeFileSync(path, "before");
  let action: ReturnType<typeof initial.assistantWork.proposeAction>;
  try {
    const work = initial.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "sink-error", workKey: "sink-error", workTitle: "Managed log regression",
      observedAt: at, evidence: {},
      provenance: { principal: "system", channel: "fixture", subject: "work", evidenceId: "sink-error" },
    }, at).work;
    const preflight = await preflightLocalFileAction({
      workId: work.id, semanticKey: "edit", operations: [{ operation: "write_file", path, content: "after" }],
    });
    action = initial.assistantWork.proposeAction(preflight.proposal, at);
    expect(await executeManagedLocalFileAction({
      repository: initial.assistantWork, actionId: action.id, revision: action.revision, digest: action.digest,
      attemptId: "seed-attempt", workerId: "fixture", now: () => at,
    })).toMatchObject({ kind: "confirmed" });
    initial.assistantWork.setFollowupPolicy({
      workId: work.id, actionId: action.id, enabled: true, intervalMs: 60_000, maxAttempts: 1,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "sink-policy" },
    }, at);
  } finally {
    initial.close();
  }
  writeFileSync(path, "before");
  const db = new Database(paths.stateDb);
  try {
    db.query("UPDATE assistant_work_actions SET state = 'approval_pending' WHERE id = ?").run(action.id);
  } finally {
    db.close();
  }
  const probes: BootstrapProbes = {
    config: async () => ({ status: "missing", reason: "hermetic core-only fixture" }),
    credentials: async () => ({ status: "passed" }),
    fda: async () => ({ status: "passed" }),
    accessibility: async () => ({ status: "passed" }),
    messages: async () => ({ status: "passed" }),
  };
  const runtime = await startDaemon({
    paths, probes, reprobeIntervalMs: 60_000,
    mainSessionFactory: {
      create: async () => ({
        sessionFile: join(root, "main.jsonl"), sessionId: "work-error-test", prompt: async () => {},
      }),
    },
  });
  try {
    const context = `Assistant work followup failed for work ${action.workId} action ${action.id}`;
    const message = await waitForLog(paths.daemonLog, "unsupported assistant action state approval_pending");
    expect(message).toContain(context);
    expect(message).toContain(`action ${action.id}, work ${action.workId}, revision ${action.revision}, digest ${action.digest}`);
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(runtime.store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    expect(runtime.store.assistantWork.listFollowupDispatches(action.workId)).toHaveLength(0);

    // Inject at the existing repository boundary; the real timer, recovery
    // wrapper, main wiring, and durable logger remain in the path.
    const cyclic = new Error(`cyclic repository failure ${"x".repeat(20_000)}`);
    cyclic.cause = cyclic;
    const readAction = spyOn(runtime.store.assistantWork, "getAction").mockImplementation(() => { throw cyclic; });
    try {
      const bounded = await waitForLog(paths.daemonLog, "cyclic repository failure");
      expect(bounded).toContain(context);
      expect(bounded).toContain("[cyclic cause]");
      expect(bounded).not.toContain("x".repeat(513));
      expect(bounded.length).toBeLessThan(4_300);
    } finally {
      readAction.mockRestore();
    }
  } finally {
    await runtime.stop();
  }
}, 30_000);
