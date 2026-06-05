const EXAMPLE_PROMPT =
  "Create a modern mobile login screen with two fields: username and password, " +
  "a primary login button, a forgot password link, and a clean minimal style.";

const promptEl = document.getElementById("prompt");
const charCount = document.getElementById("char-count");
const sendBtn = document.getElementById("send-btn");
const exampleBtn = document.getElementById("example-btn");
const logEl = document.getElementById("log");
const resultSection = document.getElementById("result-section");
const screenshotEl = document.getElementById("screenshot");
const downloadLink = document.getElementById("download-link");
const extractedText = document.getElementById("extracted-text");

// Character counter
promptEl.addEventListener("input", () => {
  charCount.textContent = `${promptEl.value.length} / 4000`;
});

// Load example prompt
exampleBtn.addEventListener("click", () => {
  promptEl.value = EXAMPLE_PROMPT;
  charCount.textContent = `${EXAMPLE_PROMPT.length} / 4000`;
});

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "screenshot";
}

function appendLog(message, type = "info") {
  const line = document.createElement("span");
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  logEl.appendChild(line);
  logEl.appendChild(document.createElement("br"));
  logEl.scrollTop = logEl.scrollHeight;
}

function setLoading(loading) {
  sendBtn.disabled = loading;
  sendBtn.textContent = loading ? "Generating…" : "Send to Claude Design";
}

sendBtn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    appendLog("Please enter a prompt before sending.", "error");
    return;
  }

  const mode = getMode();
  setLoading(true);
  logEl.textContent = "";
  resultSection.classList.add("hidden");
  extractedText.classList.add("hidden");

  appendLog(`Sending prompt to Claude Design (mode: ${mode})…`, "info");

  try {
    const response = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, mode }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      appendLog(`Error: ${data.message ?? "Unknown error"}`, "error");
      return;
    }

    appendLog(data.message, "ok");

    // Show screenshot
    const cacheBust = `?t=${Date.now()}`;
    screenshotEl.src = data.screenshotPath + cacheBust;
    downloadLink.href = data.screenshotPath;
    downloadLink.download = data.screenshotPath.split("/").pop() ?? "design.png";
    resultSection.classList.remove("hidden");

    // Show extracted text if present
    if (data.text) {
      extractedText.textContent = data.text;
      extractedText.classList.remove("hidden");
    }
  } catch (err) {
    appendLog(`Request failed: ${err.message}`, "error");
  } finally {
    setLoading(false);
  }
});
