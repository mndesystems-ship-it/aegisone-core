const gpuCount = document.getElementById("gpuCount");
const hours = document.getElementById("hours");
const gpuPrice = document.getElementById("gpuPrice");
const retryOnFail = document.getElementById("retryOnFail");
const maxRetries = document.getElementById("maxRetries");
const autoScale = document.getElementById("autoScale");
const scaleMultiplier = document.getElementById("scaleMultiplier");
const killSwitch = document.getElementById("killSwitch");
const failedAutoScale = document.getElementById("failedAutoScale");
const observedGpuCount = document.getElementById("observedGpuCount");
const runButton = document.getElementById("runButton");
const safeButton = document.getElementById("safeButton");
const unsafeButton = document.getElementById("unsafeButton");
const hoursLimitButton = document.getElementById("hoursLimitButton");
const costLimitButton = document.getElementById("costLimitButton");
const retryLimitButton = document.getElementById("retryLimitButton");
const autoScaleButton = document.getElementById("autoScaleButton");
const failedAutoScaleButton = document.getElementById("failedAutoScaleButton");
const killSwitchButton = document.getElementById("killSwitchButton");
const verifyButton = document.getElementById("verifyButton");
const gpuDown = document.getElementById("gpuDown");
const gpuUp = document.getElementById("gpuUp");
const hoursDown = document.getElementById("hoursDown");
const hoursUp = document.getElementById("hoursUp");
const decision = document.getElementById("decision");
const reason = document.getElementById("reason");
const totalCost = document.getElementById("totalCost");
const preventedCost = document.getElementById("preventedCost");
const requestHash = document.getElementById("requestHash");
const decisionHash = document.getElementById("decisionHash");
const logOutput = document.getElementById("logOutput");
const verifyOutput = document.getElementById("verifyOutput");
const decisionHero = document.getElementById("decisionHero");
const heroReason = document.getElementById("heroReason");
const decisionCard = document.getElementById("decisionCard");
const projectedCost = document.getElementById("projectedCost");
const costBar = document.getElementById("costBar");
const costBreakdown = document.getElementById("costBreakdown");
const historyList = document.getElementById("historyList");
const history = [];
const POLICY_MAX_CENTS = 10000;

function setText(node, value) {
  node.textContent = value || "-";
}

function renderResult(payload) {
  const response = payload.mnde_response || {};
  setText(decision, response.decision);
  setText(decisionHero, response.decision);
  setText(heroReason, response.reason_code);
  decision.className = response.decision === "ALLOW" ? "allow" : response.decision === "REFUSE" ? "refuse" : "";
  decisionHero.className = decision.className;
  decisionCard.className = response.decision === "ALLOW" ? "decision-card allow-card" : response.decision === "REFUSE" ? "decision-card refuse-card" : "decision-card";
  setText(reason, response.reason_code);
  setText(totalCost, response.total_cost_usd);
  setText(preventedCost, response.prevented_cost_usd);
  setText(requestHash, response.request_hash);
  setText(decisionHash, response.decision_hash);
  logOutput.textContent = JSON.stringify(payload, null, 2);
  addHistory(response);
}

function centsToUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function priceToCents() {
  return Math.max(1, Math.round(Number(gpuPrice.value || 0) * 100));
}

function currentCostCents() {
  const retryMultiplier = retryOnFail.checked ? Number(maxRetries.value || 0) + 1 : 1;
  const scale = autoScale.checked ? Number(scaleMultiplier.value || 1) : 1;
  return Number(gpuCount.value || 0) * Number(hours.value || 0) * priceToCents() * retryMultiplier * scale;
}

function updatePreview() {
  const cents = currentCostCents();
  projectedCost.textContent = centsToUsd(cents);
  const percent = Math.min((cents / POLICY_MAX_CENTS) * 100, 100);
  costBar.style.width = `${percent}%`;
  costBar.style.background = cents > POLICY_MAX_CENTS
    ? "linear-gradient(90deg, var(--amber), var(--red))"
    : "linear-gradient(90deg, var(--green), var(--blue))";
  const parts = [
    `${Number(gpuCount.value || 0)} GPUs`,
    `${Number(hours.value || 0)} hours`,
    centsToUsd(priceToCents())
  ];
  if (autoScale.checked) {
    parts.push(`${Number(scaleMultiplier.value || 1)}x autoscale`);
  }
  if (retryOnFail.checked) {
    parts.push(`${Number(maxRetries.value || 0) + 1} attempts`);
  }
  if (killSwitch.checked) {
    parts.push("kill switch active");
  }
  if (failedAutoScale.checked) {
    parts.push(`runtime update: observed ${Number(observedGpuCount.value || 0)} GPUs`);
  }
  costBreakdown.textContent = parts.join(" x ");
}

function setScenario(options) {
  gpuCount.value = String(options.gpus);
  hours.value = String(options.runHours);
  gpuPrice.value = Number(options.price ?? 5).toFixed(2);
  retryOnFail.checked = Boolean(options.retry);
  maxRetries.value = String(options.retries ?? 0);
  autoScale.checked = Boolean(options.scale);
  scaleMultiplier.value = String(options.multiplier ?? 1);
  killSwitch.checked = Boolean(options.kill);
  failedAutoScale.checked = Boolean(options.failedScale);
  observedGpuCount.value = String(options.observedGpus ?? options.gpus);
  updatePreview();
}

function bump(input, amount) {
  const min = Number(input.min || 1);
  const max = Number(input.max || 1000);
  const next = Math.min(Math.max(Number(input.value || min) + amount, min), max);
  input.value = String(next);
  updatePreview();
}

function addHistory(response) {
  if (!response.decision) {
    return;
  }
  history.unshift({
    decision: response.decision,
    reason: response.reason_code,
    total: response.total_cost_usd,
    prevented: response.prevented_cost_usd,
    hash: response.request_hash
  });
  history.splice(6);
  historyList.innerHTML = "";
  for (const item of history) {
    const row = document.createElement("div");
    row.className = `history-item ${item.decision === "ALLOW" ? "allow-item" : "refuse-item"}`;
    row.innerHTML = `
      <strong class="${item.decision === "ALLOW" ? "allow" : "refuse"}">${item.decision} / ${item.reason}</strong>
      <span>Total ${item.total} / Prevented ${item.prevented}</span>
      <span>${item.hash}</span>
    `;
    historyList.appendChild(row);
  }
}

async function runDemo() {
  runButton.disabled = true;
  try {
    const res = await fetch("/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gpu_count: Number(gpuCount.value),
        hours: Number(hours.value),
        gpu_hour_cents: priceToCents(),
        retry_on_fail: retryOnFail.checked,
        max_retries: Number(maxRetries.value),
        auto_scale: autoScale.checked,
        max_scale_multiplier: Number(scaleMultiplier.value),
        kill_switch_active: killSwitch.checked,
        observed_gpu_count: failedAutoScale.checked ? Number(observedGpuCount.value) : Number(gpuCount.value)
      })
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.message || payload.error || "demo request failed");
    }
    renderResult(payload);
  } catch (error) {
    logOutput.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    runButton.disabled = false;
  }
}

async function verifyLastReceipt() {
  verifyButton.disabled = true;
  try {
    const res = await fetch("/verify-last-receipt", { method: "POST" });
    const payload = await res.json();
    verifyOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    verifyOutput.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    verifyButton.disabled = false;
  }
}

runButton.addEventListener("click", runDemo);
safeButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 4 });
  runDemo();
});
unsafeButton.addEventListener("click", () => {
  setScenario({ gpus: 99, runHours: 4 });
  runDemo();
});
hoursLimitButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 12 });
  runDemo();
});
costLimitButton.addEventListener("click", () => {
  setScenario({ gpus: 4, runHours: 6 });
  runDemo();
});
retryLimitButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 4, retry: true, retries: 3 });
  runDemo();
});
autoScaleButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 4, scale: true, multiplier: 2 });
  runDemo();
});
failedAutoScaleButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 4, failedScale: true, observedGpus: 6 });
  runDemo();
});
killSwitchButton.addEventListener("click", () => {
  setScenario({ gpus: 2, runHours: 4, kill: true });
  runDemo();
});
verifyButton.addEventListener("click", verifyLastReceipt);
gpuDown.addEventListener("click", () => bump(gpuCount, -1));
gpuUp.addEventListener("click", () => bump(gpuCount, 1));
hoursDown.addEventListener("click", () => bump(hours, -1));
hoursUp.addEventListener("click", () => bump(hours, 1));
for (const control of [gpuCount, hours, gpuPrice, maxRetries, scaleMultiplier, retryOnFail, autoScale, killSwitch, failedAutoScale, observedGpuCount]) {
  control.addEventListener("input", updatePreview);
  control.addEventListener("change", updatePreview);
}
updatePreview();
