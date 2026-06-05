import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import https from "https";
import { generate, submitAnswer, closeBrowser } from "./automation/claudeDesign.js";

// ── File logging ─────────────────────────────────────────────────────────────
const LOG_DIR = path.resolve("logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, "app.log"), { flags: "a" });

function writeLog(level: string, ...args: unknown[]) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(" ")}\n`;
  logStream.write(line);
  level === "ERROR" ? process.stderr.write(line) : process.stdout.write(line);
}

const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...a) => writeLog("INFO", ...a);
console.error = (...a) => writeLog("ERROR", ...a);

async function telegramRequest(method: string, body: object): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${token}/${method}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function sendTelegram(message: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await telegramRequest("sendMessage", { chat_id: chatId, text: message });
}

// Poll Telegram for a reply from the user, waiting up to timeoutMs
async function waitForTelegramReply(afterMs: number, timeoutMs: number): Promise<string | null> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return null;
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const res = await telegramRequest("getUpdates", { offset, timeout: 20, allowed_updates: ["message"] }) as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string; date: number } }> } | null;
    if (res?.ok && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (msg && String(msg.chat.id) === chatId && msg.text && msg.date * 1000 > afterMs) {
          return msg.text;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "./outputs");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUT_DIR));

// ── Job queue ────────────────────────────────────────────────────────────────

type JobStatus = "queued" | "running" | "awaiting_answer" | "done" | "failed";

interface Job {
  id: string;
  prompt: string;
  mode: "screenshot" | "text";
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: {
    success: boolean;
    message: string;
    screenshotPath: string | null;
    text: string | null;
  };
  error?: string;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let workerRunning = false;

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;

  while (queue.length > 0) {
    const jobId = queue.shift()!;
    const job = jobs.get(jobId);
    if (!job) continue;

    job.status = "running";
    job.startedAt = Date.now();
    console.log(`[queue] Starting job ${jobId} — prompt: "${job.prompt.slice(0, 60)}"`);

    try {
      let result = await generate({ prompt: job.prompt, mode: job.mode });

      // If Claude Design asked questions, wait for user's Telegram reply
      if (result.questions) {
        job.status = "awaiting_answer";
        const askedAt = Date.now();
        await sendTelegram(
          `❓ Claude Design has questions about your prompt:\n\n${result.questions}\n\nReply here with your answer to continue.`
        );
        console.log(`[queue] Job ${jobId} awaiting answer via Telegram`);

        const answer = await waitForTelegramReply(askedAt, 10 * 60 * 1000); // 10 min timeout
        if (!answer) {
          throw new Error("No answer received within 10 minutes.");
        }

        console.log(`[queue] Got answer for job ${jobId}: "${answer.slice(0, 80)}"`);
        job.status = "running";
        result = await submitAnswer(answer, job.mode);
      }

      const filename = path.basename(result.screenshotPath);
      job.status = "done";
      job.result = {
        success: result.success,
        message: result.message,
        screenshotPath: `/outputs/${filename}`,
        text: result.text,
      };
      console.log(`[queue] Job ${jobId} done`);
      sendTelegram(`✅ Job done\nPrompt: "${job.prompt.slice(0, 100)}"\nScreenshot: ${job.result.screenshotPath}`).catch(() => {});
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[queue] Job ${jobId} failed:`, job.error);
      sendTelegram(`❌ Job failed\nPrompt: "${job.prompt.slice(0, 100)}"\nReason: ${job.error}`).catch(() => {});
    }

    job.finishedAt = Date.now();
  }

  workerRunning = false;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.post("/generate", (req: Request, res: Response) => {
  if (workerRunning) {
    res.status(409).json({ success: false, message: "A job is already running. Try again when it finishes." });
    return;
  }

  const prompt = ((req.body as { prompt?: string }).prompt ?? "").trim();
  const rawMode = ((req.body as { mode?: string }).mode ?? "screenshot").toLowerCase();
  const mode: "screenshot" | "text" = rawMode === "text" ? "text" : "screenshot";

  if (!prompt) {
    res.status(400).json({ success: false, message: "prompt is required" });
    return;
  }
  if (prompt.length > 4000) {
    res.status(400).json({ success: false, message: "prompt is too long (max 4000 chars)" });
    return;
  }

  const job: Job = {
    id: randomUUID(),
    prompt,
    mode,
    status: "queued",
    createdAt: Date.now(),
  };

  jobs.set(job.id, job);
  queue.push(job.id);
  console.log(`[queue] Enqueued job ${job.id} (queue length: ${queue.length})`);
  sendTelegram(`📥 Job queued\nPrompt: "${job.prompt.slice(0, 100)}"\nQueue position: ${queue.length}`).catch(() => {});

  runWorker();

  res.status(202).json({ jobId: job.id, status: "queued" });
});

app.get("/jobs/:id", (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ success: false, message: "Job not found" });
    return;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    result: job.result ?? null,
    error: job.error ?? null,
  });
});

app.get("/jobs", (_req: Request, res: Response) => {
  const list = Array.from(jobs.values()).map((j) => ({
    jobId: j.id,
    status: j.status,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? null,
  }));
  res.json(list);
});

app.get("/jobs/pending", (_req: Request, res: Response) => {
  const pending = Array.from(jobs.values())
    .filter((j) => j.status === "queued" || j.status === "running")
    .map((j) => ({
      jobId: j.id,
      status: j.status,
      prompt: j.prompt.slice(0, 100),
      createdAt: j.createdAt,
      startedAt: j.startedAt ?? null,
    }));
  res.json({ count: pending.length, jobs: pending });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", queueLength: queue.length, workerRunning });
});

app.get("/logs", (req: Request, res: Response) => {
  const logFile = path.join(LOG_DIR, "app.log");
  const lines = parseInt((req.query.lines as string) ?? "100", 10);
  if (!fs.existsSync(logFile)) { res.json({ lines: [] }); return; }
  const content = fs.readFileSync(logFile, "utf-8").trim().split("\n");
  res.json({ lines: content.slice(-lines) });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[server] Error:", message);
  res.status(500).json({ success: false, message });
});

// ── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n[server] Claude Design Automation running at http://localhost:${PORT}`);
  console.log(`[server] Output directory: ${OUTPUT_DIR}`);
});

function shutdown() {
  console.log("\n[server] Shutting down...");
  server.close(async () => {
    await closeBrowser();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
