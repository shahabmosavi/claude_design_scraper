import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import https from "https";
import { generate, closeBrowser } from "./automation/claudeDesign.js";

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const body = JSON.stringify({ chat_id: chatId, text: message });
  await new Promise<void>((resolve) => {
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "./outputs");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUT_DIR));

// ── Job queue ────────────────────────────────────────────────────────────────

type JobStatus = "queued" | "running" | "done" | "failed";

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
      const result = await generate({ prompt: job.prompt, mode: job.mode });
      const filename = path.basename(result.screenshotPath);
      job.status = "done";
      job.result = {
        success: result.success,
        message: result.message,
        screenshotPath: `/outputs/${filename}`,
        text: result.text,
      };
      console.log(`[queue] Job ${jobId} done`);
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

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", queueLength: queue.length, workerRunning });
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
