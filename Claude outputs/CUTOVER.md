# Credentials cutover — runbook

Moving the login table out of `Guest_Ops_System_Database` and off single-round
SHA-256, without locking anybody out and without anyone resetting a password.

**Nothing in `index.html` changes.** This is entirely Apps Script plus two
spreadsheets. If you follow step 7 the `/exec` URL stays the same.

---

## What's already done

A new private spreadsheet exists:

**Guest Ops — Auth (PRIVATE, do not publish or share)**
`118gN0uOaJ0LrklrYhiBOq9nNzCb3Iwi-_628Dv4zv2w`

Columns: `username · name · salt · hash · algo · iterations · updated_at`,
seeded with all 8 usernames and no credentials. Sharing checked: owner only,
no link sharing.

Leave it that way. It should never be published to web, never be shared to
"anyone with the link", and never be moved into a shared folder.

---

## How the migration works

`verifyLogin()` checks the new sheet first. If a user has no PBKDF2 hash yet,
it falls back to the old tab, verifies against the legacy SHA-256, and — on
success — writes them a fresh PBKDF2 hash in the new sheet.

So people keep their current passwords, and migrate silently as they sign in
over the following days. The old tab stays readable until the last person has
been through, then it goes.

---

## Steps

### 1. Add the file

Apps Script editor → **+ → Script** → name it `Auth` → paste in `Auth.gs`.

### 2. Tell it where the old tab is

In `Auth.gs`, set `LEGACY_TAB` to the exact name of the tab in
`Guest_Ops_System_Database` holding `username | name | salt | hash`.
`LEGACY_SHEET_ID` is already filled in.

### 3. Work out the old hash arrangement

The old scheme is one SHA-256 round over some arrangement of salt and
password — I can see the shape of the stored values but not which arrangement
produced them. Run this once in the editor, with **your own** username and
current password:

```js
detectLegacyScheme('jordan', 'your current password')
```

It prints which variant matched. Put that number in `LEGACY_VARIANT`.

Then **clear your password back out of the editor and save** — Apps Script keeps
file edit history.

> If it reports no match, don't guess. Send me the login function from the
> script and I'll extend the variant list.

### 4. Pick a work factor

```js
benchmarkPbkdf2()
```

Prints timings for 5,000 → 100,000 iterations on your actual deployment. Take
the largest one marked `(good)` and set `PBKDF2_ITERATIONS` to it.

The trade: every sign-in pays this cost once, and every offline guess against a
stolen hash pays it too. Around 300–800 ms is the sweet spot. Apps Script is
slower than a compiled language here, so don't be surprised if you land nearer
20,000 than 100,000 — even 20,000 is roughly 20,000× harder to attack than
what's stored today.

### 5. Prove it works

```js
selfTest()
```

Must print **ALL PASS**. It checks the PBKDF2 output against published test
vectors, so a pass means the hashing is genuinely correct and not just
self-consistent. If anything fails, stop here.

### 6. Wire it into your login handler

Find where the script handles `action == 'login'`. Replace the password check —
not the token issuing — with a call to `verifyLogin`:

```js
if (action === 'login') {
  var result = verifyLogin(data.username, data.password);
  if (!result.ok) {
    return json({ ok: false, error: 'Sign in failed' });
  }
  // ... your existing token issuing, unchanged, using result.name
}
```

Keep the error message vague. Don't distinguish "no such user" from "wrong
password" — `verifyLogin` is already careful not to leak that through response
timing, and the message shouldn't give it away either.

### 7. Deploy without changing the URL

**Deploy → Manage deployments →** pencil icon on the *existing* deployment **→
Version: New version → Deploy.**

Do **not** use "New deployment" — that issues a new `/exec` URL and you'd have
to edit and re-upload `index.html`.

### 8. Verify

1. Sign in to the dashboard as yourself. It should work with your current password.
2. Open the auth sheet. Your row should now have a salt, a hash, `pbkdf2-sha256`, and today's date.
3. Sign out and back in — still works, now via the new path.
4. Try a deliberately wrong password. Should fail.

If sign-in breaks: set `LEGACY_VARIANT = 0` and redeploy. That makes it try
every arrangement, which is slower but more forgiving.

### 9. Let everyone migrate

Over the next few days:

```js
migrationStatus()
```

It lists who's migrated and who's still on a legacy hash. Nobody needs to do
anything except sign in as normal. Nudge any stragglers to log in once.

### 10. Delete the old tab — only when the list is empty

When `migrationStatus()` says everyone's migrated:

1. In `Guest_Ops_System_Database`, delete the `username | name | salt | hash` tab.
2. Set `LEGACY_SHEET_ID = ''` in `Auth.gs`.
3. Redeploy as in step 7.
4. Run `migrationStatus()` once more to confirm nothing broke.

---

## Day-to-day, afterwards

```js
setPassword('sophie', 'a new password for sophie')   // reset someone
addUser('marta', 'Marta')                            // returns a generated password, once
removeUser('tom')                                    // run the day someone leaves
```

`addUser` returns the password in the editor log and nowhere else — copy it
straight out and send it over something you trust, not the shared Slack channel.

---

## Two things this does not fix

**Weak passwords.** A slow hash buys time against someone attacking a stolen
hash; it does nothing if a password is guessable in a handful of tries. Worth a
round of `setPassword` for anyone still on something short, once the migration
has settled.

**The `unlock_admin` question.** Still open from the review: the Manage tab fires
`unlock_admin` with `code:''` on every open, and whether that grants admin
depends on script code I can't see. Unrelated to this change, but it's the next
thing I'd look at.

---

## While you're in the spreadsheet

Check how the two dashboard tabs are published: **File → Share → Publish to web**.
The first dropdown should name a single tab — *Task Log* and *Changeover
Tracker* respectively — and not say **Entire document**. That setting is what
this whole exercise is insuring against.
