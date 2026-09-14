# Unplugged · Guest Ops Live Dashboard

An internal operations dashboard for the cabin business. One self-contained
`index.html` — no build step, no framework, no package manager, no dependencies.
Open the file in a browser and it runs.

Sign-in is required: the dashboard checks credentials against a Google Apps
Script backend and holds a token for 12 hours.

## Tabs

| Tab | What it's for |
|---|---|
| Today | The day's task rhythm — progress bar, due / later / ongoing |
| Changeover forms | Cabins changing over today vs. cleaner feedback received; overdue after 3pm |
| Payments | Deposit-only and part-paid bookings to chase |
| Booking alerts | Detects two stays colliding in the same cabin |
| Blocks | BLOCKED entries — maintenance, holds, shoots; flags clashes and forgotten blocks |
| Fix-it | Searchable troubleshooting guide — steps to try before calling anyone out |
| Leave | Log sick / last-minute leave and who approved it |
| Activity log | Every ✅ reaction in #guest-ops-dashboard |
| History | Trends from the ✅ log — most-missed tasks, by day of week |
| Resources | Links out to Notion, Google Forms, Trustpilot |
| All tasks | Filterable table of every task |
| Manage | Admin editing of timings, headings, resources and templates |

## Data sources

Three, all set in the `CONFIG` object at the top of the `<script>` block in
`index.html`:

| Key | What it is |
|---|---|
| `TASKS_API` | Google Apps Script web app (`/exec`). Tasks, resources, payments, blocks, booking alerts, leave, troubleshooting, login, admin unlock. |
| `TASKLOG_CSV` | Google Sheet → "Task Log" tab → Publish to web → CSV |
| `CHANGEOVER_CSV` | Google Sheet → "Changeover Tracker" tab → Publish to web → CSV |

Leaving a key empty degrades gracefully: with no `TASKS_API` the dashboard falls
back to the task list baked into `index.html` and shows read-only hints; with no
CSV URLs the Activity log, History and Changeover tabs show a "connect this"
hint instead of data.

See **[SETUP.md](SETUP.md)** for the two CSVs and **[TASKS_SETUP.md](TASKS_SETUP.md)**
for the Apps Script backend.

## Running it

Open `index.html` in a browser — locally, from a shared drive, or from any static
host. There are no external script or style requests; the only network calls are
to the three URLs in `CONFIG`.

## Working on it

`index.html` is one large file with very long lines. Edit it in the clone and
commit from there:

```
git add index.html
git commit -m "Describe what changed"
git push
```

Uploading through the GitHub web UI produces "Add files via upload" commits with
no useful diff — avoid it.

## Known gaps

- The Apps Script backend is not in this repo. Login, token issuing and every
  data query live there and can't be reviewed or rolled back from here.
- Both published-CSV URLs require no authentication. Anyone with the URL can
  read those sheet tabs.
- `action=tasks` is fetched without a token, so the task list and resources are
  readable by anyone with the `/exec` URL.
