# API Reference

The server exposes a small JSON API from `src/server.ts`. Generation is asynchronous: clients enqueue a job, receive a `jobId`, and poll until the job reaches a terminal state.

## Job lifecycle

```text
queued -> running -> done
queued -> running -> awaiting_answer -> running -> done
queued -> running -> failed
```

| Status | Meaning |
|---|---|
| `queued` | The request was accepted and is waiting behind any active job. |
| `running` | The Playwright worker is interacting with Claude Design. |
| `awaiting_answer` | Claude Design asked clarifying questions and the server is waiting for a Telegram reply. |
| `done` | A final result is available. |
| `failed` | The worker threw an error; `error` contains the failure message. |

Jobs are kept in memory. Restarting the server clears queued, running, completed, and failed job status, although failed jobs are also cached in `logs/failed-jobs.json` so Telegram retry buttons can recover them.

## POST `/generate`

Enqueue a Claude Design generation job.

### Request body

```json
{
  "prompt": "A minimal SaaS pricing page with three tiers",
  "mode": "screenshot"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | Yes | Trimmed before validation. Max 4000 characters. |
| `mode` | `"screenshot"` or `"text"` | No | Defaults to `screenshot`. Unknown values fall back to `screenshot`. |

`mode: "screenshot"` is the reliable path. `mode: "text"` still captures screenshots but also attempts best-effort DOM extraction of assistant text; `result.text` may be `null`.

### Success response

Status: `202 Accepted`

```json
{
  "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
  "status": "queued"
}
```

### Validation errors

Status: `400 Bad Request`

```json
{
  "success": false,
  "message": "prompt is required"
}
```

```json
{
  "success": false,
  "message": "prompt is too long (max 4000 chars)"
}
```

## GET `/jobs/:id`

Fetch the current status and result for one job.

### Running response

```json
{
  "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
  "status": "running",
  "createdAt": 1780761600000,
  "startedAt": 1780761602500,
  "finishedAt": null,
  "result": null,
  "error": null
}
```

### Done response

```json
{
  "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
  "status": "done",
  "createdAt": 1780761600000,
  "startedAt": 1780761602500,
  "finishedAt": 1780761685000,
  "result": {
    "success": true,
    "message": "Generation complete. Screenshot saved.",
    "screenshotPath": "/outputs/design-1780761684500.png",
    "text": null
  },
  "error": null
}
```

### Failed response

```json
{
  "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
  "status": "failed",
  "createdAt": 1780761600000,
  "startedAt": 1780761602500,
  "finishedAt": 1780761620000,
  "result": null,
  "error": "Could not find the prompt input field. The Claude Design UI may have changed."
}
```

### Missing job

Status: `404 Not Found`

```json
{
  "success": false,
  "message": "Job not found"
}
```

## Polling example

```bash
job_id=$(
  curl -s -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" \
    -d '{"prompt":"A landing page for an AI note-taking app","mode":"screenshot"}' |
  node -e "const fs = require('fs'); process.stdout.write(JSON.parse(fs.readFileSync(0, 'utf8')).jobId)"
)

while true; do
  response=$(curl -s "http://localhost:3000/jobs/$job_id")
  status=$(printf '%s' "$response" | node -e "const fs = require('fs'); process.stdout.write(JSON.parse(fs.readFileSync(0, 'utf8')).status)")
  printf '%s\n' "$response"

  if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
    break
  fi

  sleep 5
done
```

## POST `/jira`

Webhook endpoint that enqueues a screenshot-mode design job from a Jira issue. The prompt comes from `issue.description` when present, otherwise `issue.summary`.

### Request body

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": {
    "key": "DESIGN-123",
    "summary": "Create a new dashboard screen",
    "description": "Design a dashboard with revenue cards, trend charts, and recent alerts."
  }
}
```

### Success response

Status: `202 Accepted`

```json
{
  "jobId": "42bb3f78-7ea5-4fd7-8d24-3c06da42ba48",
  "status": "queued",
  "issueKey": "DESIGN-123"
}
```

When Jira environment variables are configured, a successful generation creates a follow-up Jira Task containing the screenshot URL and optional Claude Code share command.

### Validation error

Status: `400 Bad Request`

```json
{
  "success": false,
  "message": "No description or summary in Jira payload."
}
```

## GET `/jobs`

List all in-memory jobs in summary form.

```json
[
  {
    "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
    "status": "done",
    "createdAt": 1780761600000,
    "finishedAt": 1780761685000
  }
]
```

## GET `/jobs/pending`

List queued and running jobs.

```json
{
  "count": 1,
  "jobs": [
    {
      "jobId": "8f61c7d0-65de-4fd3-95df-4b9500f5aeb1",
      "status": "running",
      "prompt": "A minimal SaaS pricing page with three tiers",
      "createdAt": 1780761600000,
      "startedAt": 1780761602500
    }
  ]
}
```

## GET `/health`

Basic process and queue health.

```json
{
  "status": "ok",
  "queueLength": 0,
  "workerRunning": false
}
```

## GET `/logs?lines=N`

Return the last `N` lines from `logs/app.log`. `N` defaults to `100`.

```json
{
  "lines": [
    "[2026-06-06T16:00:00.000Z] [INFO] [queue] Enqueued job ..."
  ]
}
```

## Static files

Final and diagnostic screenshots are served from `/outputs/<filename>` and stored in the directory configured by `OUTPUT_DIR`.
