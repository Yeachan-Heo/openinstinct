#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const logPath = process.env.OI_PACKAGE_MANAGER_LOG;
if (logPath) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(argv)}\n`, "utf8");
}

const cwdIndex = argv.indexOf("--cwd");
const destination = cwdIndex >= 0 ? argv[cwdIndex + 1] : undefined;
const packageSpec = argv.at(-1);
if (argv[0] !== "add" || !destination || !packageSpec) {
  console.error("fixture expected Bun add argv");
  process.exit(64);
}

if (process.env.OI_PACKAGE_MANAGER_MODE === "fail_before_change") {
  process.exit(23);
}
if (process.env.OI_PACKAGE_MANAGER_MODE === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  const child = Bun.spawn([
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
  ], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || Buffer.from(ready.value).toString("utf8").trim() !== "ready") {
    process.exit(70);
  }
  child.unref();
  if (process.env.OI_PACKAGE_MANAGER_PARENT_PID) {
    await writeFile(process.env.OI_PACKAGE_MANAGER_PARENT_PID, String(process.pid), "utf8");
  }
  if (process.env.OI_PACKAGE_MANAGER_CHILD_PID) {
    await writeFile(process.env.OI_PACKAGE_MANAGER_CHILD_PID, String(child.pid), "utf8");
  }
  await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
}

const separator = packageSpec.startsWith("@")
  ? packageSpec.indexOf("@", packageSpec.indexOf("/") + 1)
  : packageSpec.lastIndexOf("@");
const packageName = packageSpec.slice(0, separator);
const packageVersion = packageSpec.slice(separator + 1);
const packageJsonPath = join(destination, "package.json");
const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
const dependencies = typeof manifest.dependencies === "object" && manifest.dependencies !== null
  ? { ...(manifest.dependencies as Record<string, unknown>) }
  : {};

dependencies[packageName] = packageVersion;
manifest.dependencies = dependencies;
await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const installedRoot = join(destination, "node_modules", ...packageName.split("/"));
await mkdir(installedRoot, { recursive: true });
await writeFile(join(installedRoot, "package.json"), `${JSON.stringify({
  name: packageName,
  version: packageVersion,
}, null, 2)}\n`, "utf8");
await writeFile(join(installedRoot, "installed.txt"), "fixture install evidence\n", "utf8");

if (process.env.OI_PACKAGE_MANAGER_MODE === "fail_after_change") {
  process.exit(24);
}
console.log("fixture install complete");
