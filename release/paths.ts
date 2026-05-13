import path from "path";
import { fileURLToPath } from "url";

const APP_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PACKAGE_ROOT = path.resolve(APP_ROOT, "..");
export const PROVENANCE_PATH = path.join(PACKAGE_ROOT, "provenance.json");
export const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");
export const DEFAULT_AUDIT_OUTPUT_DIR = path.join(PACKAGE_ROOT, "audit_output");
export const DEFAULT_BENCHMARK_OUTPUT_DIR = path.join(PACKAGE_ROOT, "sustained-benchmark-bundle");
export const NODE_BINARY_PATH = path.join(PACKAGE_ROOT, "bin", "node", process.platform === "win32" ? "node.exe" : "node");
export const RUST_PARITY_BINARY_PATH = path.join(
  PACKAGE_ROOT,
  "bin",
  "rust",
  process.platform === "win32" ? "parity_runner.exe" : "parity_runner"
);

export const APP_ENTRY_PATHS = {
  auditRun: path.join(APP_ROOT, "audit", "run.js"),
  emitParityVectors: path.join(APP_ROOT, "audit", "emit_parity_vectors.js"),
  attackWave: path.join(APP_ROOT, "audit", "run_attack_wave.js"),
  remediationWave: path.join(APP_ROOT, "audit", "run_remediation_wave.js"),
  postRemediationVerification: path.join(APP_ROOT, "audit", "run_post_remediation_verification.js"),
  controlledBenchmark: path.join(APP_ROOT, "benchmark", "run_mnde_controlled_benchmark.js"),
  sustainedBenchmark: path.join(APP_ROOT, "release", "run_sustained_benchmark.js")
};

