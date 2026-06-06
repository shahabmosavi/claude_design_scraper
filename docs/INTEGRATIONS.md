# Integrations

This project can run without external services, but Telegram and Jira unlock notifications, retries, clarifying-question handling, and follow-up implementation task creation.

## Telegram

Telegram support is enabled when both of these environment variables are set:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### What Telegram receives

- Job queued messages with the prompt preview and queue position.
- Interrupted generation messages when Claude Design appears stuck and the worker retries.
- Completion messages with the screenshot path.
- Failure messages with an inline Retry button.
- Browser crash notifications when the automation detects a Chrome "Aw, Snap!" page.
- Clarifying questions from Claude Design, when the model asks questions instead of generating.

### Retry button behavior

When a job fails, the server writes a compact retry record to `logs/failed-jobs.json` and sends a Telegram message with an inline Retry button. Pressing the button:

1. Acknowledges the callback query.
2. Loads the failed job from memory or `logs/failed-jobs.json`.
3. Removes the failed-job cache entry.
4. Enqueues a new job with the original prompt, mode, and optional source Jira issue key.

The failed-job cache keeps only the latest 100 entries.

### Clarifying-question flow

If Claude Design asks questions instead of generating a screen, the worker sets the job status to `awaiting_answer`, sends the questions to Telegram, and waits up to 30 minutes for a text reply from `TELEGRAM_CHAT_ID`.

If a reply arrives in time, the worker submits it to the already-open Claude Design page and continues generation. If no reply arrives, the job fails and can be retried.

### Setup notes

1. Create a bot with BotFather and copy its token.
2. Send a message to the bot from the target chat.
3. Resolve the numeric chat ID with Telegram's `getUpdates` API or a trusted chat-ID helper.
4. Add the token and chat ID to `.env`.
5. Restart the server so the callback poller starts with the new configuration.

The callback poller uses Telegram long polling with a 20-second timeout and starts once when the Express server boots.

## Jira

Jira support has two parts:

1. `POST /jira` accepts incoming Jira webhooks and creates design generation jobs.
2. Successful jobs can create a follow-up Jira Task containing the screenshot URL and Claude Code share command.

Set all of these variables to enable follow-up task creation:

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=DESIGN
```

### Incoming webhook

Configure Jira to send issue-created or issue-updated webhooks to:

```text
https://your-domain.example/jira
```

The server reads:

- `issue.description` as the prompt when present.
- `issue.summary` as the fallback prompt.
- `issue.key` as optional source context.

The prompt is truncated to 4000 characters and queued in `screenshot` mode.

### Follow-up task creation

After a successful generation, `createJiraTask()` creates a Task in `JIRA_PROJECT_KEY` with:

- Summary: `Frontend implementation - <source issue key or prompt preview>`
- Description paragraph with the source issue or manual-request label.
- Original prompt preview.
- Screenshot URL.
- Claude Code command code block when the share flow succeeds.

The screenshot URL is built as:

```text
<JIRA_BASE_URL without trailing slash><result.screenshotPath>
```

If `JIRA_BASE_URL` is your Atlassian domain, that URL will not point at this app. For public screenshot links, set the base URL behavior in code or route screenshots through a public app domain before relying on Jira task links.

## Claude Code share command

When Claude Design reports a generated result, the automation attempts:

1. Click `Share`.
2. Open the `Send to...` tab.
3. Find the `Claude Code` destination row.
4. Click `Send`.
5. Read a command from a `pre`, `code`, command-like element, or intercepted clipboard write.
6. Click `Copy command`.

This is best effort because it depends on Claude Design's current UI. If the share flow fails, generation can still succeed; the Jira task is created without the command block.

## Security notes

- The API does not implement authentication. Put it behind a trusted network, reverse proxy controls, or a webhook secret check before exposing it publicly.
- Do not log bot tokens, Jira tokens, cookie values, storage state, or session screenshots that contain private data.
- `cookies.json`, `.env`, `auth/storageState.json`, `logs/`, and generated output files are gitignored.
