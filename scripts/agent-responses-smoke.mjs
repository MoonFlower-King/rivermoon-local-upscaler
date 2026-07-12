#!/usr/bin/env node

const url = "https://img.rivermoon7.com/v1/responses";
const passes = [];
const failures = [];

function pass(message) {
  passes.push(message);
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

console.log(`RiverMoon agent responses smoke: ${url}`);

let response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      reasoning_effort: "medium",
      input: [{ role: "user", content: [{ type: "input_text", text: "non billing smoke" }] }]
    }),
    signal: AbortSignal.timeout(20_000)
  });
  assert(response.status === 401 || response.status === 403, `agent endpoint requires auth (HTTP ${response.status})`);
} catch (error) {
  fail(`agent endpoint request failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (response) {
  const contentType = response.headers.get("Content-Type") || "";
  assert(contentType.includes("application/json"), "agent auth failure response is JSON");
  const body = await response.text();
  assert(/unauthorized|auth|permission|令牌|权限/i.test(body), "agent auth failure body is recognizable");
  assert(!body.includes("sk-"), "agent auth failure body does not echo API keys");
}

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`Agent responses smoke failed: ${failures.length} failure(s).`);
  process.exit(1);
}

console.log(`Agent responses smoke passed: ${passes.length} pass(es).`);
