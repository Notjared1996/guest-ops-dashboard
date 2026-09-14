# Fix-it guide — feature handover

**Paste this whole file into a new chat working on `unplugged-changeover`.**

It describes a feature that exists and works in a different project (the Guest Ops
Live Dashboard), and how it should be rebuilt in this one. It carries the *structure*
deliberately, not the content — the 20 issues, contractor names and escalation
thresholds stay in the other system and get re-entered here by the office.

Written against `unplugged-changeover` at HANDOFF.md as of 14 Sep 2026.

---

## 1. What the feature is

A guided troubleshooting flow for the person standing in the cabin with a broken
thing. Pick the problem from a list, and the app walks you through:

1. **Red flags** — stop and call us now if any of these. Shown before anything else.
2. **Ask the guest** — safe questions and steps a guest can do themselves.
3. **On-site checks** — numbered diagnostic steps, **one at a time**, each with
   "that sorted it" or "done, next check".
4. **Either outcome** — fixed (close it off), or escalate (who to call, and why).

At each stage there are copy-to-clipboard message templates: a first message to the
guest, a first message to the person on site, and closing messages for both.

The point is to stop unnecessary callouts. Most "the boiler's broken" turns out to be
a tripped switch, an empty canister or an eco-mode inverter, and a new cleaner has no
way of knowing that. The guide turns institutional knowledge into something someone
in their first week can work through without phoning anyone.

## 2. Why it belongs in this app rather than the dashboard

In the original, the audience is office staff at a desk who then relay steps over
SMS. In this app the audience is the changeover team, on a phone, **in the cabin,
looking at the thing**. That's the right place for it, and it makes one requirement
non-negotiable that the original doesn't have at all — see §5.

## 3. What it is NOT

**Not guest issues (§6d).** That feature answers *is the guest looked after* and
finishes with compensation and follow-ups. This one answers *can we fix this without
calling anyone out*, and finishes either with a working boiler or a contractor. They
have different audiences, different timelines and different endings. Keep them apart
for the same reasons §6d gives for keeping guest issues apart from tickets.

**Not a checklist template.** Checklist items and guest-issue follow-ups are *copied
onto each instance* at creation. Fix guides are the opposite — a read-only reference
library that many tickets consult and none owns. Do not copy guide steps onto a
ticket. (Recording *that* somebody worked a guide before escalating is worth doing —
see §7.3 — but that's a note on the ticket, not a copy of the guide.)

**Not a ticket replacement.** The guide runs *before* a ticket, and often instead of
one. When it ends in escalation, that's when a ticket gets raised.

---

## 4. Data model

### Do not port the original's shape

The original stores everything in one flat sheet:

```
issue_type | kind | seq | label | text
```

…where `kind` is one of `count · priority · urgent · redflag · guest · step ·
escalate · contact · template`, and the backend pivots ~350 such rows into nested
JSON on every read. That shape exists **only** because Google Sheets can't hold
nested data and the office needed to edit it in a spreadsheet. Neither constraint
applies here. Porting it would be cargo-culting a workaround into a database that
doesn't need it.

### Proposed schema

Fits the conventions already in `schema.prisma` — `cuid()` ids, `Cascade` on the
owning relation, ordering columns named `seq`, enums for closed vocabularies.

```prisma
enum FixStepRole {
  GUEST   // safe things to ask the guest to try
  TEAM    // on-site checks for the changeover team
}

enum FixTemplateSlot {
  GUEST_FIRST
  GUEST_CLOSE
  TEAM_FIRST
  TEAM_CLOSE
}

/// One troubleshooting guide, keyed by the same issue vocabulary as Task.issueType.
model FixGuide {
  id         String  @id @default(cuid())

  /// MUST use the same vocabulary as `Task.issueType` — see §7.1.
  issueType  String  @unique

  /// "AMBER — same-day" etc. Free text in the original; consider an enum.
  priority   String?

  /// "Treat as urgent if …" — one line, shown next to the priority.
  urgentIf   String?

  /// What to do when the checks run out. Prose; the contractors are separate.
  escalation String?

  active     Boolean @default(true)

  redFlags   FixRedFlag[]
  steps      FixStep[]
  templates  FixTemplate[]

  /// Who to call when it escalates. A relation, not free text — see §7.2.
  contractors Contractor[] @relation("FixGuideContractors")

  updatedAt  DateTime @updatedAt
  createdAt  DateTime @default(now())
}

/// Stop-and-call-now conditions. Rendered before everything else, never skippable.
model FixRedFlag {
  id      String   @id @default(cuid())
  guideId String
  guide   FixGuide @relation(fields: [guideId], references: [id], onDelete: Cascade)
  seq     Int
  text    String

  @@index([guideId, seq])
}

/// One check, for either audience. Role + seq gives the two ordered lists.
model FixStep {
  id      String      @id @default(cuid())
  guideId String
  guide   FixGuide    @relation(fields: [guideId], references: [id], onDelete: Cascade)
  role    FixStepRole
  seq     Int
  text    String

  @@index([guideId, role, seq])
}

/// A copy-paste message. One per slot per guide.
model FixTemplate {
  id      String          @id @default(cuid())
  guideId String
  guide   FixGuide        @relation(fields: [guideId], references: [id], onDelete: Cascade)
  slot    FixTemplateSlot
  body    String

  @@unique([guideId, slot])
}
```

`Contractor` needs the back-relation adding:

```prisma
  fixGuides Contractor[] @relation("FixGuideContractors")   // on FixGuide
  fixGuides FixGuide[]   @relation("FixGuideContractors")   // on Contractor
```

### What I've deliberately left out

- **`count`** (how many times this issue has been logged). The original uses it to
  sort the list most-common-first. Here you can derive it from `Task.issueType`
  instead of storing it — better, because it stays true.
- **`label` on non-template rows.** Unused in the original; an artefact of the flat
  sheet.

---

## 5. Offline is the requirement, not a nice-to-have

**This is the single biggest difference from the original, and the thing most likely
to be missed.**

A cleaner working out why there's no hot water is, by definition, in a remote cabin.
That is exactly where there's no signal. A troubleshooting guide that needs the
network is useless precisely when it's needed.

So the guide data must be precached alongside the other snapshots — the same
machinery as `components/team/PrecacheSnapshots.tsx` / `CacheSnapshot.tsx` and
`lib/offline/*`. Specifics for whoever builds this:

- The whole library is small (20 guides, a few hundred short strings) and changes
  rarely. Cache **all of it**, not per-cabin slices.
- It is **read-only on the team side**, so it needs no place in the `SyncOp` queue —
  which makes it much simpler than reports or photos.
- Copy-to-clipboard works offline; sending doesn't. The templates copy into whatever
  messaging app they use, so that's fine — but don't build a "send" button that
  silently fails without signal.
- If the guide ends in escalation offline, raising the ticket **does** need queuing,
  through the existing offline queue.

## 6. The interaction, precisely

A three-state machine. Worth copying exactly — it's the part that works.

```
                    ┌─────────┐
      pick issue →  │  STEPS  │  one check on screen, index into TEAM steps
                    └────┬────┘
             ┌───────────┴───────────┐
   "that sorted it"            "done, next check"
             │                       │
             ▼                  (seq exhausted)
        ┌─────────┐                  │
        │  FIXED  │                  ▼
        └─────────┘            ┌──────────┐
     closing templates         │ ESCALATE │
                               └──────────┘
                          who to call + raise a ticket
```

State is `{ guideId, stepIndex, mode }` where mode is `steps | fixed | escalate`.
Back-a-step is allowed; start-over resets to `stepIndex 0, mode steps`.

Showing **one check at a time** is the deliberate bit. It stops people skim-reading
five steps, doing none properly, and calling anyway. Keep it — but see §8.2.

---

## 7. Decisions to make before writing code

### 7.1 Is `Task.issueType` a controlled vocabulary?

Right now it's `String?`, free text, and `Contractor.trade` is "matched loosely
against" it. `FixGuide.issueType` should use the **same** vocabulary, because that
join is what makes the whole thing pay off:

- From a guide that escalates → raise a ticket with `issueType` prefilled.
- From a ticket → offer "work the Fix-it checks for this" if a guide matches.
- Contractor suggestion already works off `trade` ↔ `issueType`.

If `issueType` is currently free text in practice, **this is the moment to decide**
whether to pin it to a list. Doing it later means backfilling tickets. Ask the office
before choosing — a fixed list is better for matching and worse for the one-off
issue that doesn't fit.

### 7.2 Contractors are records here, not strings

The original stores escalation contacts as free-text lines like
`"<name> — <trade>: <what they cover>"`. This app has a `Contractor` model with
`phone`, `email`, `trade` and an `active` flag.

Link them properly. The payoff on a phone in a cabin is immediate: a tappable
`tel:` link instead of a name to go and look up. It also means a contractor who
leaves disappears from every guide at once, rather than being wrong in twenty places.

Keep `FixGuide.escalation` as prose for the *policy* ("no same-day fix and the stay is
affected → move the guest"), and let the contractor relation carry the *people*.

### 7.3 Does working a guide leave a trace?

The original records nothing. Worth doing here, cheaply: when a guide ends in a
ticket, note on the ticket which guide was worked and how far it got. Two reasons —
the contractor arrives knowing what's already been checked, and over time you learn
which guides never resolve anything and need rewriting.

A line on `TaskMessage`, or a nullable `Task.fixGuideId`, is enough. Don't build
analytics for it yet.

### 7.4 Who can edit the guides?

The precedent is Team & setup (`/manage/…`), admin-gated, like the checklist template
and guest-issue follow-ups. Follow it. Editing a guide is rare and consequential —
a wrong step here sends someone to poke at a gas appliance.

---

## 8. Things that will bite

### 8.1 Search has to match step text, not just issue names

The original's search filters on the issue title only. That's the wrong end: nobody
searching knows the problem is filed under "Boiler / Hot Water" — they search what
the guest told them, "no hot water", "cold shower", "error 70". Index the step, red
flag and `urgentIf` text too. You already have `lib/boardSearch.ts` as a precedent
for a search helper.

### 8.2 One-step-at-a-time hides the overview

Good for doing the job, bad for judging how long it'll take or finding the step you
half-remember. Add a "show all checks" toggle that expands the list read-only. The
original has no such thing and it's the most obvious gap.

### 8.3 Red flags must be unskippable

They're the safety content — gas smells, high CO, cracked burner glass. Render them
before the steps, in their own visually distinct block, and don't collapse them by
default. If anything gets a confirm-tap before proceeding, it's this.

### 8.4 The content is the work, not the code

The schema is an afternoon. Twenty guides at ~17 rows each is a few hundred pieces of
institutional knowledge that mostly live in people's heads. Build the office editor
properly — bulk-ish entry, reorder, duplicate-a-guide — because someone is going to
sit and type all of it, and if that screen is painful the feature stays empty. The
original shipped with an empty state reading "an admin needs to run a seed script",
which is a fair description of the problem it never solved.

Consider seeding two or three guides in `seed.mjs` as worked examples, the way
`GUEST_ISSUE_STEPS` seeds the follow-up starters, so the editor has something to
show on day one.

### 8.5 Priority strings

`"AMBER — same-day"` is free text in the original and drives a coloured dot by
substring match on `RED` / `AMBER`. That's fragile. Either make it an enum or drop
the colour — don't keep the substring sniffing.

---

## 9. Suggested shape in this repo

Following the conventions already in `src/`:

```
prisma/schema.prisma                      + the models in §4
src/lib/fixGuides.ts                      pure rules, no DB import (cf. guestIssues.ts)
src/app/_actions/fixGuides.ts             office editing actions
src/app/manage/fix-it/page.tsx            list of guides
src/app/manage/fix-it/[id]/page.tsx       edit one guide
src/app/team/fix-it/page.tsx              pick an issue
src/app/team/fix-it/[issueType]/page.tsx  work the checks
src/components/manage/FixGuideEditor.tsx
src/components/manage/FixStepManager.tsx  (cf. StepManager.tsx)
src/components/team/FixRunner.tsx         the three-state machine
src/lib/offline/…                         add guides to the precached snapshot
```

Add a `TeamTabs` entry for the team side and a `ManageSidebar` entry for the office
side.

## 10. When it's built

Add a section to `HANDOFF.md` — probably `## 6l. The Fix-it guide` — in the same
style as the rest: what it is, what's deliberate about it, what will bite, and the
file list at the end. Per §4 of that document, the repo copy is the authoritative one.

---

## 11. Reference: the original implementation

For whoever wants to see it working before rebuilding. Public repo:
`https://github.com/Notjared1996/guest-ops-dashboard` — the Fix-it code is in
`index.html`, functions `loadFix` / `renderFixList` / `openFix` / `renderFix`, around
lines 439–478, plus the `<section id="v-fix">` markup at line 99.

It's vanilla JS rendering by string concatenation against a Google Apps Script
endpoint, so treat it as a description of behaviour rather than code to copy. The
state machine in §6 and the stage ordering in §1 are the parts worth preserving
exactly; everything else should be rebuilt to this app's patterns.
