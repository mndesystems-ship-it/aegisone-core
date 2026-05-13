"use strict";

import { SCENARIOS, buildRequest, estimateTotalCostCents, valuesFromRequest } from "./request-builder.js";

const API_BASE = "http://127.0.0.1:8787";
const ENDPOINTS = {
  decide: "/v1/decisions",
  verify: "/verify",
  replay: "/replay",
  healthz: "/healthz",
  readyz: "/readyz"
};

const els = {
  healthzStatus: document.querySelector("#healthzStatus"),
  readyzStatus: document.querySelector("#readyzStatus"),
  policyVersion: document.querySelector("#policyVersion"),
  policyHash: document.querySelector("#policyHash"),
  canonicalStatus: document.querySelector("#canonicalStatus"),
  requestForm: document.querySelector("#requestForm"),
  requestEditor: document.querySelector("#requestEditor"),
  requestFileInput: document.querySelector("#requestFileInput"),
  importRequestBtn: document.querySelector("#importRequestBtn"),
  applyJsonBtn: document.querySelector("#applyJsonBtn"),
  safePresetBtn: document.querySelector("#safePresetBtn"),
  highCostPresetBtn: document.querySelector("#highCostPresetBtn"),
  syncObservedBtn: document.querySelector("#syncObservedBtn"),
  userIdInput: document.querySelector("#userIdInput"),
  regionInput: document.querySelector("#regionInput"),
  requestIdInput: document.querySelector("#requestIdInput"),
  executionIdInput: document.querySelector("#executionIdInput"),
  toolInput: document.querySelector("#toolInput"),
  gpuTypeInput: document.querySelector("#gpuTypeInput"),
  gpuCountInput: document.querySelector("#gpuCountInput"),
  hoursInput: document.querySelector("#hoursInput"),
  gpuHourCentsInput: document.querySelector("#gpuHourCentsInput"),
  estimatedTotalOutput: document.querySelector("#estimatedTotalOutput"),
  actualGpuCountInput: document.querySelector("#actualGpuCountInput"),
  actualHoursInput: document.querySelector("#actualHoursInput"),
  actualTotalCostCentsInput: document.querySelector("#actualTotalCostCentsInput"),
  killSwitchActiveInput: document.querySelector("#killSwitchActiveInput"),
  lifecycleStateInput: document.querySelector("#lifecycleStateInput"),
  holdStateInput: document.querySelector("#holdStateInput"),
  signatureInput: document.querySelector("#signatureInput"),
  alreadyConsumedInput: document.querySelector("#alreadyConsumedInput"),
  autoScaleInput: document.querySelector("#autoScaleInput"),
  retryOnFailInput: document.querySelector("#retryOnFailInput"),
  maxRetriesInput: document.querySelector("#maxRetriesInput"),
  maxScaleMultiplierInput: document.querySelector("#maxScaleMultiplierInput"),
  sendBtn: document.querySelector("#sendBtn"),
  errorBox: document.querySelector("#errorBox"),
  decisionBadge: document.querySelector("#decisionBadge"),
  reasonCode: document.querySelector("#reasonCode"),
  totalCost: document.querySelector("#totalCost"),
  allowedCost: document.querySelector("#allowedCost"),
  preventedCost: document.querySelector("#preventedCost"),
  requestHash: document.querySelector("#requestHash"),
  decisionHash: document.querySelector("#decisionHash"),
  replayBtn: document.querySelector("#replayBtn"),
  verifyBtn: document.querySelector("#verifyBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  receiptFileInput: document.querySelector("#receiptFileInput"),
  importReceiptBtn: document.querySelector("#importReceiptBtn"),
  actionResult: document.querySelector("#actionResult"),
  tabRaw: document.querySelector("#tabRaw"),
  tabPretty: document.querySelector("#tabPretty"),
  tabHashInputs: document.querySelector("#tabHashInputs"),
  receiptDropTarget: document.querySelector("#receiptDropTarget"),
  receiptImportStatus: document.querySelector("#receiptImportStatus"),
  receiptViewer: document.querySelector("#receiptViewer")
};

const state = {
  receipt: null,
  rawReceipt: "",
  response: null,
  activeTab: "pretty",
  activePreset: "safe"
};

const controlBindings = {
  userId: els.userIdInput,
  requestId: els.requestIdInput,
  executionId: els.executionIdInput,
  region: els.regionInput,
  tool: els.toolInput,
  gpuType: els.gpuTypeInput,
  gpuCount: els.gpuCountInput,
  hours: els.hoursInput,
  gpuHourCents: els.gpuHourCentsInput,
  actualGpuCount: els.actualGpuCountInput,
  actualHours: els.actualHoursInput,
  actualTotalCostCents: els.actualTotalCostCentsInput,
  lifecycleState: els.lifecycleStateInput,
  holdState: els.holdStateInput,
  signature: els.signatureInput,
  killSwitchActive: els.killSwitchActiveInput,
  autoScale: els.autoScaleInput,
  retryOnFail: els.retryOnFailInput,
  maxRetries: els.maxRetriesInput,
  maxScaleMultiplier: els.maxScaleMultiplierInput,
  alreadyConsumed: els.alreadyConsumedInput
};

function readControls() {
  const values = {};
  for (const [key, element] of Object.entries(controlBindings)) {
    values[key] = element.type === "checkbox" ? element.checked : element.value;
  }
  return values;
}

function writeControls(values, presetName) {
  for (const [key, element] of Object.entries(controlBindings)) {
    if (!(key in values)) continue;
    if (element.type === "checkbox") {
      element.checked = Boolean(values[key]);
    } else {
      element.value = values[key];
    }
  }
  state.activePreset = presetName || "";
  els.safePresetBtn.classList.toggle("active", state.activePreset === "safe");
  els.highCostPresetBtn.classList.toggle("active", state.activePreset === "highCost");
  refreshGeneratedRequest(presetName ? `${SCENARIOS[presetName]?.label || "Sample"} loaded` : "controls updated");
}

function formatUsdFromCents(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function refreshGeneratedRequest(statusText) {
  try {
    const values = readControls();
    const request = buildRequest(values);
    els.requestEditor.value = pretty(request);
    els.estimatedTotalOutput.value = formatUsdFromCents(estimateTotalCostCents(values));
    els.canonicalStatus.textContent = statusText || "controls mapped";
    showError("");
    return request;
  } catch (error) {
    els.canonicalStatus.textContent = "needs attention";
    showError(error.message || "ERR_INVALID_CONTROLS");
    return null;
  }
}

function syncObservedToEstimate() {
  const values = readControls();
  els.actualGpuCountInput.value = values.gpuCount;
  els.actualHoursInput.value = values.hours;
  try {
    els.actualTotalCostCentsInput.value = estimateTotalCostCents(values);
  } catch {
    els.actualTotalCostCentsInput.value = "";
  }
  refreshGeneratedRequest("observed values updated");
}

function failClosed(message, details) {
  state.receipt = null;
  state.rawReceipt = "";
  setDecision({
    decision: "REFUSE",
    reason_code: message,
    request_hash: null,
    decision_hash: null
  });
  setReceiptControls(false);
  showError(details ? `${message}\n${details}` : message);
}

function showError(message) {
  els.errorBox.textContent = message || "";
}

function setText(element, value) {
  element.textContent = value === undefined || value === null || value === "" ? "none" : String(value);
}

function setStatus(element, ok, text) {
  element.textContent = text;
  element.style.color = ok ? "var(--allow)" : "var(--refuse)";
}

function setDecision(body) {
  const decision = body?.decision === "ALLOW" ? "ALLOW" : "REFUSE";
  els.decisionBadge.textContent = decision;
  els.decisionBadge.className = `badge ${decision === "ALLOW" ? "badge-allow" : "badge-refuse"}`;
  setText(els.reasonCode, body?.reason_code);
  setText(els.totalCost, body?.total_cost_usd);
  setText(els.allowedCost, body?.allowed_cost_usd);
  setText(els.preventedCost, body?.prevented_cost_usd);
  setText(els.requestHash, body?.request_hash);
  setText(els.decisionHash, body?.decision_hash);
}

function setReceiptControls(enabled) {
  els.replayBtn.disabled = !enabled;
  els.verifyBtn.disabled = !enabled;
  els.copyBtn.disabled = !enabled;
  els.exportBtn.disabled = !enabled;
}

function setReceipt(receipt, statusText) {
  state.receipt = receipt;
  state.rawReceipt = canonicalize(receipt);
  setReceiptControls(true);
  setDecision({
    decision: receipt?.decision_output?.decision,
    reason_code: receipt?.decision_output?.reason_code,
    request_hash: receipt?.request_hash ?? receipt?.decision_output?.request_hash,
    decision_hash: receipt?.decision_output?.decision_hash,
    total_cost_usd: receipt?.decision_output?.total_cost_usd,
    allowed_cost_usd: receipt?.decision_output?.allowed_cost_usd,
    prevented_cost_usd: receipt?.decision_output?.prevented_cost_usd
  });
  els.receiptImportStatus.textContent = statusText || "receipt loaded";
  renderReceipt();
}

function parseNumberToken(token) {
  if (!/^-?(0|[1-9]\d*)$/.test(token)) {
    throw new Error("ERR_INVALID_JSON_NUMBER");
  }
  const number = Number(token);
  if (!Number.isSafeInteger(number)) {
    throw new Error("ERR_INVALID_JSON_NUMBER");
  }
  return number;
}

function strictParseJson(source) {
  let index = 0;

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(source[index] || "")) index += 1;
  }

  function parseString() {
    if (source[index] !== "\"") throw new Error("ERR_INVALID_JSON_SYNTAX");
    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === "\"") {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (char === "\\") {
        index += 1;
        if (source[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
            throw new Error("ERR_INVALID_JSON_SYNTAX");
          }
          index += 5;
        } else if ("\"\\/bfnrt".includes(source[index] || "")) {
          index += 1;
        } else {
          throw new Error("ERR_INVALID_JSON_SYNTAX");
        }
      } else {
        if (char < " ") throw new Error("ERR_INVALID_JSON_SYNTAX");
        index += 1;
      }
    }
    throw new Error("ERR_INVALID_JSON_SYNTAX");
  }

  function parseArray() {
    const value = [];
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return value;
    }
    while (index < source.length) {
      value.push(parseValue());
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return value;
      }
      if (source[index] !== ",") throw new Error("ERR_INVALID_JSON_SYNTAX");
      index += 1;
      skipWhitespace();
    }
    throw new Error("ERR_INVALID_JSON_SYNTAX");
  }

  function parseObject() {
    const value = {};
    const seen = new Set();
    index += 1;
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return value;
    }
    while (index < source.length) {
      const key = parseString();
      if (seen.has(key)) throw new Error("ERR_DUPLICATE_JSON_KEYS");
      seen.add(key);
      skipWhitespace();
      if (source[index] !== ":") throw new Error("ERR_INVALID_JSON_SYNTAX");
      index += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return value;
      }
      if (source[index] !== ",") throw new Error("ERR_INVALID_JSON_SYNTAX");
      index += 1;
      skipWhitespace();
    }
    throw new Error("ERR_INVALID_JSON_SYNTAX");
  }

  function parseValue() {
    skipWhitespace();
    const char = source[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === "\"") return parseString();
    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:[.eE][+\-]?\d+)?/);
      if (!match) throw new Error("ERR_INVALID_JSON_SYNTAX");
      index += match[0].length;
      return parseNumberToken(match[0]);
    }
    if (source.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (source.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (source.startsWith("null", index)) {
      index += 4;
      return null;
    }
    throw new Error("ERR_INVALID_JSON_SYNTAX");
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) throw new Error("ERR_INVALID_JSON_SYNTAX");
  return value;
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error("ERR_UNSUPPORTED_JSON_VALUE");
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function receiptHashInputs(receipt) {
  if (!receipt) return "No receipt yet.";
  return pretty({
    request_hash_input: receipt.canonical_request ?? null,
    decision_hash_input: receipt.decision_output ? {
      decision: receipt.decision_output.decision,
      reason_code: receipt.decision_output.reason_code,
      request_hash: receipt.decision_output.request_hash,
      total_cost_usd: receipt.decision_output.total_cost_usd,
      allowed_cost_usd: receipt.decision_output.allowed_cost_usd,
      prevented_cost_usd: receipt.decision_output.prevented_cost_usd,
      policy_version: receipt.decision_output.policy_version,
      policy_hash: receipt.decision_output.policy_hash,
      execution_id: receipt.decision_output.execution_id
    } : null
  });
}

function renderReceipt() {
  if (!state.receipt) {
    els.receiptViewer.textContent = "No receipt yet.";
    return;
  }
  if (state.activeTab === "pretty") {
    els.receiptViewer.textContent = pretty(state.receipt);
  } else if (state.activeTab === "hashInputs") {
    els.receiptViewer.textContent = receiptHashInputs(state.receipt);
  } else {
    els.receiptViewer.textContent = state.rawReceipt;
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  for (const [name, element] of [["raw", els.tabRaw], ["pretty", els.tabPretty], ["hashInputs", els.tabHashInputs]]) {
    const active = name === tab;
    element.classList.toggle("active", active);
    element.setAttribute("aria-selected", active ? "true" : "false");
  }
  renderReceipt();
}

async function fetchJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    const wrapped = new Error("ERR_MNDE_UNREACHABLE_OR_CORS");
    wrapped.details = [
      `Could not reach ${API_BASE}${path}.`,
      "Start the MNDe sidecar on 127.0.0.1:8787.",
      location.protocol === "file:" ? "If MNDe is running, serve this UI from http://127.0.0.1:8080 instead of file:// so the browser does not block the request." : "",
      error.message ? `Browser error: ${error.message}` : ""
    ].filter(Boolean).join("\n");
    throw wrapped;
  }
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = strictParseJson(text);
    } catch {
      body = JSON.parse(text);
    }
  }
  if (!response.ok) {
    const reason = body?.reason_code || `HTTP_${response.status}`;
    throw new Error(reason);
  }
  return body;
}

async function refreshStatus() {
  try {
    const health = await fetchJson(ENDPOINTS.healthz, { method: "GET", headers: {} });
    setStatus(els.healthzStatus, Boolean(health?.ok), health?.ok ? "ok" : "fail");
    if (health?.active_policy_version) setText(els.policyVersion, health.active_policy_version);
  } catch (error) {
    setStatus(els.healthzStatus, false, error.message || "fail");
  }

  try {
    const ready = await fetchJson(ENDPOINTS.readyz, { method: "GET", headers: {} });
    setStatus(els.readyzStatus, Boolean(ready?.ok), ready?.ok ? "ok" : "fail");
    setText(els.policyVersion, ready?.active_policy_version);
    setText(els.policyHash, ready?.policy_hash);
  } catch (error) {
    setStatus(els.readyzStatus, false, error.message || "fail");
  }
}

function canonicalizeEditor() {
  const parsed = buildRequest(readControls());
  const canonical = canonicalize(parsed);
  els.requestEditor.value = pretty(parsed);
  els.canonicalStatus.textContent = "controls mapped";
  return { parsed, canonical };
}

function extractReceipt(value) {
  if (value?.receipt && typeof value.receipt === "object") return value.receipt;
  if (value?.body?.receipt && typeof value.body.receipt === "object") return value.body.receipt;
  if (value?.response?.body?.receipt && typeof value.response.body.receipt === "object") return value.response.body.receipt;
  if (value?.decision_output && value?.canonical_request) return value;
  throw new Error("ERR_RECEIPT_NOT_FOUND");
}

function loadRequestValue(value, statusText) {
  const values = valuesFromRequest(value);
  writeControls(values, "");
  els.canonicalStatus.textContent = statusText || "request loaded into controls";
}

function applyJsonEditorToControls() {
  try {
    loadRequestValue(strictParseJson(els.requestEditor.value), "advanced JSON applied");
  } catch (error) {
    failClosed(error.message || "ERR_INVALID_JSON", "Advanced JSON was not applied to controls.");
  }
}

function loadReceiptValue(value, statusText) {
  const receipt = extractReceipt(value);
  setReceipt(receipt, statusText || "receipt loaded");
  showError("");
  els.actionResult.textContent = "";
}

async function sendRequest() {
  showError("");
  els.actionResult.textContent = "";
  let canonical;
  try {
    canonical = canonicalizeEditor().canonical;
  } catch (error) {
    failClosed(error.message || "ERR_INVALID_CONTROLS", "Request was not sent.");
    return;
  }

  try {
    const body = await fetchJson(ENDPOINTS.decide, { method: "POST", body: canonical });
    state.response = body;
    setDecision(body);
    if (body?.receipt) {
      setReceipt(body.receipt, "receipt returned");
      showError("");
    } else {
      state.receipt = null;
      state.rawReceipt = "";
      setReceiptControls(false);
      renderReceipt();
      showError("No receipt returned. UI remains fail-closed for replay and verify actions.");
    }
  } catch (error) {
    failClosed(error.message || "ERR_DECIDE_FAILED", error.details || "MNDe decision request failed.");
  }
}

async function receiptAction(path, label) {
  if (!state.receipt) {
    failClosed("ERR_NO_RECEIPT", `${label} requires a receipt.`);
    return;
  }
  try {
    const result = await fetchJson(path, {
      method: "POST",
      body: canonicalize({ receipt: state.receipt })
    });
    els.actionResult.textContent = pretty(result);
  } catch (error) {
    failClosed(error.message || `ERR_${label.toUpperCase()}_FAILED`, error.details || `${label} failed.`);
  }
}

async function copyReceipt() {
  if (!state.rawReceipt) return;
  try {
    await navigator.clipboard.writeText(state.rawReceipt);
    els.actionResult.textContent = "OK_COPIED_RECEIPT";
  } catch (error) {
    failClosed("ERR_COPY_FAILED", error.message);
  }
}

function exportReceipt() {
  if (!state.rawReceipt) return;
  const blob = new Blob([`${state.rawReceipt}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mnde-receipt-${state.receipt?.decision_output?.decision_hash || "local"}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readDroppedFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("ERR_FILE_READ_FAILED"));
    reader.readAsText(file);
  });
}

async function importFile(input, loader) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    loader(strictParseJson(await readDroppedFile(file)));
  } catch (error) {
    failClosed(error.message || "ERR_FILE_IMPORT_FAILED", "Imported content was not accepted.");
  }
}

async function handleJsonDrop(event, loader) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-active");
  const file = event.dataTransfer?.files?.[0];
  const textItem = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/plain");
  try {
    const source = file ? await readDroppedFile(file) : textItem;
    if (!source) throw new Error("ERR_DROP_EMPTY");
    loader(strictParseJson(source));
  } catch (error) {
    failClosed(error.message || "ERR_DROP_FAILED", "Dropped content was not accepted.");
  }
}

function wireDropTarget(target, loader) {
  target.addEventListener("dragenter", (event) => {
    event.preventDefault();
    target.classList.add("drag-active");
  });
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    target.classList.add("drag-active");
  });
  target.addEventListener("dragleave", (event) => {
    if (!target.contains(event.relatedTarget)) {
      target.classList.remove("drag-active");
    }
  });
  target.addEventListener("drop", (event) => handleJsonDrop(event, loader));
}

els.safePresetBtn.addEventListener("click", () => writeControls(SCENARIOS.safe.values, "safe"));
els.highCostPresetBtn.addEventListener("click", () => writeControls(SCENARIOS.highCost.values, "highCost"));
els.syncObservedBtn.addEventListener("click", syncObservedToEstimate);
els.requestForm.addEventListener("input", () => {
  state.activePreset = "";
  els.safePresetBtn.classList.remove("active");
  els.highCostPresetBtn.classList.remove("active");
  refreshGeneratedRequest("controls updated");
});
els.requestForm.addEventListener("change", () => refreshGeneratedRequest("controls updated"));
els.importRequestBtn.addEventListener("click", () => els.requestFileInput.click());
els.requestFileInput.addEventListener("change", () => importFile(els.requestFileInput, (value) => loadRequestValue(value, "imported request loaded into controls")));
els.applyJsonBtn.addEventListener("click", applyJsonEditorToControls);
els.sendBtn.addEventListener("click", sendRequest);
els.importReceiptBtn.addEventListener("click", () => els.receiptFileInput.click());
els.receiptFileInput.addEventListener("change", () => importFile(els.receiptFileInput, (value) => loadReceiptValue(value, "imported receipt loaded")));
els.replayBtn.addEventListener("click", () => receiptAction(ENDPOINTS.replay, "Replay"));
els.verifyBtn.addEventListener("click", () => receiptAction(ENDPOINTS.verify, "Verify"));
els.copyBtn.addEventListener("click", copyReceipt);
els.exportBtn.addEventListener("click", exportReceipt);
els.tabRaw.addEventListener("click", () => setActiveTab("raw"));
els.tabPretty.addEventListener("click", () => setActiveTab("pretty"));
els.tabHashInputs.addEventListener("click", () => setActiveTab("hashInputs"));
els.requestEditor.addEventListener("input", () => {
  els.canonicalStatus.textContent = "advanced JSON edited";
});
wireDropTarget(els.receiptDropTarget, (value) => loadReceiptValue(value, "dropped receipt loaded"));
els.receiptViewer.addEventListener("dragstart", (event) => {
  if (!state.rawReceipt) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData("application/json", state.rawReceipt);
  event.dataTransfer.setData("text/plain", state.rawReceipt);
  event.dataTransfer.effectAllowed = "copy";
});

writeControls(SCENARIOS.safe.values, "safe");
refreshStatus();
window.setInterval(refreshStatus, 5000);
