const state = {};
const $ = (id) => document.getElementById(id);
const explorer = "https://explore.tempo.xyz";
const runButton = $("runButton");
const timeline = $("timeline");

function short(value, front = 8, back = 6) {
  if (!value || value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

function txLink(value) {
  const link = document.createElement("a");
  link.href = `${explorer}/tx/${value}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = short(value);
  return link;
}

function addressLink(value) {
  const link = document.createElement("a");
  link.href = `${explorer}/address/${value}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = short(value);
  return link;
}

function putLink(id, value, kind) {
  const target = $(id);
  target.replaceChildren(kind === "tx" ? txLink(value) : addressLink(value));
}

function parseJsonText(value) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function renderField(key, value) {
  state[key] = value;
  if (key === "nonce") $("nonce").textContent = String(value);
  if (key === "aliceBalance") {
    $("aliceBalance").textContent = String(value);
    $("aliceMeter").style.width = `${Number(value) * 5}%`;
  }
  if (key === "bobBalance") {
    $("bobBalance").textContent = String(value);
    $("bobMeter").style.width = `${Number(value) * 5}%`;
  }
  if (key === "phase") $("phase").textContent = String(value).replaceAll("-", " ");
  if (key === "agent") $("agentAddress").textContent = short(String(value));
  if (key === "channelId") $("channelId").textContent = short(String(value));
  if (key === "manager") putLink("manager", String(value), "address");
  if (key === "openTx") putLink("openTx", String(value), "tx");
  if (key === "joinTx") putLink("joinTx", String(value), "tx");
  if (key === "closeTx") putLink("closeTx", String(value), "tx");
  if (key === "requestCommitment") $("requestCommitment").textContent = String(value);
  if (key === "responseCommitment") $("responseCommitment").textContent = String(value);
  if (key === "requestPlaintext") $("requestText").textContent = parseJsonText(String(value));
  if (key === "responsePlaintext") $("responseText").textContent = parseJsonText(String(value));
  if (key === "requestStatus") {
    $("requestStatus").textContent = String(value).toUpperCase();
    $("requestMessage").classList.toggle("active", value === "acknowledged");
  }
  if (key === "responseStatus") {
    $("responseStatus").textContent = String(value).toUpperCase();
    $("responseMessage").classList.toggle("active", value === "acknowledged");
  }
  if (key === "relayRecovered") $("recovery").textContent = value ? "RECOVERED" : "PENDING";
  if (key === "settled") $("settlement").textContent = value ? "SETTLED" : "OPEN";
}

function appendEvent(event) {
  if (event.type !== "log" && event.type !== "error") return;
  timeline.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.className = `event ${event.type}`;
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  row.innerHTML = `<time>${time}</time><i></i><p></p>`;
  row.querySelector("p").textContent = event.message;
  timeline.append(row);
  timeline.scrollTop = timeline.scrollHeight;
}

function resetView() {
  Object.keys(state).forEach((key) => delete state[key]);
  timeline.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "The live run is starting…";
  timeline.append(empty);
  ["openTx", "joinTx", "closeTx"].forEach((id) => $(id).textContent = "Pending");
  $("channelId").textContent = "Waiting for channel";
  $("agentAddress").textContent = "Creating key";
  $("requestText").textContent = "Ciphertext in transit…";
  $("responseText").textContent = "Waiting for Bob's response…";
  $("requestCommitment").textContent = "No commitment yet";
  $("responseCommitment").textContent = "No commitment yet";
  $("requestMessage").classList.remove("active");
  $("responseMessage").classList.remove("active");
}

const source = new EventSource("/api/events");
source.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "reset") resetView();
  if (event.type === "field") renderField(event.key, event.value);
  if (event.type === "status" && event.key === "run") {
    $("runStatus").textContent = String(event.value).toUpperCase();
    runButton.disabled = event.value === "running";
    runButton.innerHTML = event.value === "running" ? "Running live…" : "Run again <span>↗</span>";
  }
  appendEvent(event);
};

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  const response = await fetch("/api/run", { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Unable to start demo." }));
    alert(body.error);
    runButton.disabled = false;
  }
});

$("clearLog").addEventListener("click", () => timeline.replaceChildren());

const status = await fetch("/api/status").then((response) => response.json());
if (status.manager) putLink("manager", status.manager, "address");
if (!status.configured) {
  runButton.disabled = true;
  runButton.textContent = "Configure .env first";
  $("runStatus").textContent = "NOT CONFIGURED";
}
