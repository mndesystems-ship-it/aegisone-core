#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mnde-run.mjs");
const result = spawnSync(process.execPath, [wrapper, "git", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, MNDE_TOOL: "git" },
  stdio: "inherit",
  windowsHide: true
});
process.exit(result.status ?? 1);
