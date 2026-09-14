# SETUP.md — the two published CSVs

`index.html` reads two Google Sheet tabs as published CSV. This covers both.
The Apps Script backend is separate — see [TASKS_SETUP.md](TASKS_SETUP.md).

Both tabs live in the same spreadsheet; they differ only by `gid`.

## Which tab feeds what

| CONFIG key | Sheet tab | Feeds |
|---|---|---|
| `TASKLOG_CSV` | Task Log | Activity log tab, History tab, and the "actioned" count in the Today progress bar |
| `CHANGEOVER_CSV` | Changeover Tracker | Changeover forms tab |

## Publishing a tab

1. Open the spreadsheet.
2. **File → Share → Publish to web**.
3. In the first dropdown pick the tab (not "Entire document").
4. In the second dropdown pick **Comma-separated values (.csv)**.
5. **Publish**, confirm, and copy the URL.
6. Paste it into the matching key in the `CONFIG` object at the top of the
   `<script>` block in `index.html`.

The URL looks like:

```
https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=<tab-id>&single=true&output=csv
```

Note `gid` — that's what distinguishes the two tabs. If both keys end up with the
same `gid`, one of the tabs was published twice.

## Behaviour when a key is empty

`fetchCSV()` returns `null` for an empty URL and the dashboard degrades rather
than breaking:

- No `TASKLOG_CSV` → Activity log and History show a "connect the Task Log" hint;
  the Today progress bar shows "connect Task Log CSV in CONFIG to go live".
- No `CHANGEOVER_CSV` → the Changeover forms tab shows a hint instead of cards.

A fetch that fails (unpublished, revoked, offline) is caught and surfaced as
"Could not load" rather than an error in the console.

## Security — read this before publishing

**"Publish to web" requires no authentication.** Anyone with the URL can read
the whole tab, and both URLs are in `index.html`, which is in this repository.
The sign-in gate protects the Apps Script API; it does nothing for these CSVs.

Before publishing a tab, check what's actually in it. If it carries guest names,
arrival dates, phone numbers or cabin occupancy, publishing it puts that data
behind nothing but an unguessable URL — and the URL is not unguessable if the
repo is public.

If a published URL needs to be withdrawn: **File → Share → Publish to web →
Stop publishing**. Republishing issues a new URL, so `CONFIG` has to be updated
and the change pushed.

Safer shapes, if the tabs turn out to carry guest data:

- Point the CSV at a helper tab that pulls only the non-identifying columns the
  dashboard actually uses, rather than at the raw tab.
- Or move both reads behind the Apps Script, which already has a token check, and
  drop the published CSVs entirely.

## Verifying

Open `index.html`, sign in, and check:

- Activity log lists recent ✅ rows.
- History shows most-missed tasks.
- Changeover forms lists today's cabins.

If a tab shows a "connect…" hint, the matching key is empty. If it shows "Could
not load", the URL is set but the fetch failed — most often the tab was
unpublished, or the `gid` points at a tab that no longer exists.
