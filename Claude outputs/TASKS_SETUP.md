# TASKS_SETUP.md — the Apps Script backend

`CONFIG.TASKS_API` points at a single Google Apps Script web app (`/exec`) that
serves everything except the two published CSVs: sign-in, tasks, resources,
payments, blocks, booking alerts, leave, troubleshooting and admin unlock.

> **The Apps Script source is not in this repository.** What follows is the
> contract as observed from `index.html` — the client side. Anything marked
> *unverified* could only be confirmed by reading the script itself. Getting that
> source into this repo is the single highest-value change outstanding.

## Deploying

1. Open the Apps Script project bound to the spreadsheet.
2. **Deploy → New deployment → Web app**.
3. Execute as: the account that owns the sheets.
4. Who has access: **Anyone** — the dashboard calls it from the browser with no
   Google sign-in, so it has to be reachable anonymously. The script's own token
   check is what does the gatekeeping.
5. Copy the `/exec` URL into `CONFIG.TASKS_API` in `index.html`.

Re-deploying under the *same* deployment keeps the URL. **New deployment** issues
a new one and `CONFIG` has to be updated.

## The request contract

One endpoint, routed by an `action` field.

### Reads — GET `?action=…`

| Action | Token sent? | Returns |
|---|---|---|
| `tasks` | **no** | `{ok, tasks[], resources[]}` |
| `payments` | yes | deposit-only and part-paid bookings |
| `blocks` | yes | BLOCKED entries |
| `booking_alerts` | yes | colliding stays |
| `leave` | yes | leave entries |
| `troubleshooting` | yes | Fix-it guide entries |

`action=tasks` is fetched as `?action=tasks&_=<timestamp>` with `cache:'no-store'`
and **no token**. Tasks and resources are therefore readable by anyone holding the
`/exec` URL — which is committed to this repo.

### Writes — POST with a JSON body

`apiPost()` sends `JSON.stringify(payload)` and expects `{ok:true, …}` back, or
`{ok:false, error:"…"}`, which it throws.

| Action | Body | Purpose |
|---|---|---|
| `login` | `{username, password}` | Returns `{token, name}` |
| `unlock_admin` | `{token, code}` | Returns `{adminToken}` |
| `seed` | — | Populate tasks/resources |
| `reset` | — | Clear back to defaults |
| `delete` | — | Remove a task or resource |
| `reconcile` | — | Reconcile task state |
| `payment_status` | — | Update a payment's status |
| `payment_template` | — | Save a chase-message template |
| `leave_add` | — | Add a leave entry |
| `leave_delete` | — | Remove a leave entry |

Any POST response containing `tasks[]` or `resources[]` refreshes the client's
copy, so write endpoints can return updated state and the UI picks it up.

## Sign-in

`gateLogin()` POSTs `{action:'login', username, password}`. **The password is
never in the client** — the comparison happens in the Apps Script.

On success the client stores, in `localStorage`:

| Key | Contents |
|---|---|
| `gops_token` | The session token |
| `gops_name` | Display name (falls back to the username) |
| `gops_exp` | `Date.now() + 12h` |

`initAuth()` restores these on load and shows the sign-in gate if the token is
missing or `gops_exp` has passed. Note the expiry is enforced **client-side
only** — whether the script also expires tokens server-side is *unverified*. If
it doesn't, a copied token stays valid indefinitely.

With `CONFIG.TASKS_API` empty, `initAuth()` hides the gate entirely and the
dashboard runs read-only off the built-in task list.

## Admin

A second token, `gops_admin` (with `gops_admin_exp`), gates the Manage tab and
the Leave admin view.

```js
async function ensureManageAccess(){
  loadTasks();
  if(AUTH.adminToken){renderManage();return;}
  try{
    const j=await apiPost({action:'unlock_admin',token:AUTH.token,code:''});
    if(j.adminToken)setAdminToken(j.adminToken);
  }catch(e){}
  renderManage();
}
```

**Open question.** Every time the Manage tab opens, this fires `unlock_admin`
with `code:''`, and swallows any error. Two readings:

- *Intended* — the script treats an empty code as "this signed-in user is already
  authorised, issue the admin token", and the code prompt exists for other paths.
- *A hole* — the script doesn't check `code` properly and hands an admin token to
  any signed-in user.

Which one it is depends entirely on the Apps Script, which isn't visible from
here. **Confirm this before treating the Manage tab as restricted.**

## Getting the source into the repo

Worth doing, and cheap:

- `clasp clone <scriptId>` pulls the project into a local folder that can be
  committed alongside `index.html`, and `clasp push` deploys from it.
- Failing that, copy the `.gs` files out of the Apps Script editor into a
  `backend/` folder here by hand. Stale is still better than absent.

Either way, check for hardcoded credentials before the first commit — the login
password is checked server-side, so it is likely sitting in that source.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Connect the Tasks API…" on a tab | `CONFIG.TASKS_API` is empty |
| Sign-in says "Sign in failed" | Script returned `{ok:false}` — bad credentials, or the deployment URL is stale |
| Tabs load but writes fail | Deployment access isn't "Anyone", or the script threw |
| Everything empty after a redeploy | New deployment issued a new `/exec` URL; update `CONFIG` |
| Signed out every time | `gops_exp` passed, or `localStorage` is blocked in that browser |
