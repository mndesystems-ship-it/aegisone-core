export async function postReceiptApi(endpoint, body) {
  const response = await fetch(`/receipts/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json.status === "FAILED") {
    throw Object.assign(new Error(json.reason_code || "ERR_RECEIPT_API_FAILED"), { response: json });
  }
  return json;
}

export function stableSortReceipts(receipts) {
  return [...receipts].sort((left, right) =>
    String(left.receipt_hash).localeCompare(String(right.receipt_hash)) ||
    String(left.request_hash).localeCompare(String(right.request_hash))
  );
}
