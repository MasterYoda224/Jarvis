# JARVIS ⇄ iOS Shortcuts layer

A command protocol that lets JARVIS **plan** and Shortcuts **act**, with results flowing back into JARVIS's memory.

## Why a mailbox is required

JARVIS is a static PWA on GitHub Pages. It can *read* the network, but nothing can *write* to it — there is no server. iOS Shortcuts can call any URL, but it can't reach inside the app's memory either. So the two need a shared place to meet.

```
   iPhone                         Cloudflare Worker (free)              Browser
┌───────────────┐   GET /plan    ┌──────────────────────┐   POST /plan  ┌──────────────┐
│ JARVIS Run    │ ─────────────► │  KV: plan (TTL 1h)   │ ◄──────────── │ jarvis.html  │
│ (Shortcuts)   │                │  KV: results (30d)   │               │ generates    │
│               │   POST results │                      │   GET results │ plans, reads │
│ executes      │ ─────────────► │                      │ ◄──────────── │ results back │
└───────────────┘                └──────────────────────┘               └──────────────┘
```

Three ways to run it, in order of robustness:

| Mode | Mailbox | Setup | Privacy |
|---|---|---|---|
| **A — Worker** (recommended) | Cloudflare Worker + KV | ~5 min, free | Good — random secret path, nothing public |
| **B — GitHub file** | `plan.json` in the public repo | ~2 min | **Poor** — world-readable. Plans only, never results with personal data |
| **C — Direct handoff** | none — `shortcuts://` URL scheme | 0 min | Perfect — plan never leaves the device. No `Get Contents of URL` step, and no nightly write-back |

Mode A is what this guide builds. Mode C is documented at the end as the zero-infrastructure fallback.

---

## Step 1 — Deploy the mailbox

1. Go to `dash.cloudflare.com` → **Workers & Pages** → **Create** → **Worker**
2. Paste the contents of `worker.js`
3. **Storage & Databases → KV → Create namespace** → name it `JARVIS`
4. In the Worker: **Settings → Bindings → Add → KV namespace** → Variable name `JARVIS` → select the namespace
5. **Settings → Variables → Add** → name `SECRET`, value = a long random string (32+ chars). Generate one with any password manager.
6. **Deploy**

Your base URL is:

```
https://jarvis-mailbox.<your-subdomain>.workers.dev/<SECRET>
```

Sanity check it in a browser — you should get `{"v":1,"id":null,"actions":[]}`.

## Step 2 — Point JARVIS at the mailbox

In JARVIS: **Settings → Sync endpoint** → paste the base URL above → it saves automatically.

That single field powers both directions: JARVIS POSTs plans there, and reads results back from `<base>/results` on every launch.

---

## Step 3 — Build the "JARVIS Run" Shortcut

Create a new Shortcut called exactly **`JARVIS Run`**. Actions in order:

**1. Get Contents of URL**
- URL: `<base>/plan`
- Method: **GET**
- No headers needed
- Output: the plan JSON

**2. Get Dictionary from Input** → input: *Contents of URL*

**3. If** `Dictionary Value` for key `v` **is not** `1` → **Stop This Shortcut**

**4. If** `Dictionary Value` for key `id` **is** `empty` → **Show Notification** "No plan waiting" → **Stop**

**5. Get Dictionary Value** for key `actions` in *Dictionary* → **Repeat with Each**

Inside the Repeat, read `name` and `args` as dictionaries, then branch with **If**:

| If `name` is… | Run this Shortcuts action | Args mapping |
|---|---|---|
| `setFocus` | **Set Focus** | `mode` → Focus mode |
| `openApp` | **Open App** | `name` → App |
| `openURL` | **Open URLs** | `url` → URL |
| `createReminder` | **Add New Reminder** | `title`, `due` |
| `createNote` | **Create Note** | `title`, `body` |
| `logExpense` | **Append to Text File** (or a Numbers row) | `amount`, `category`, `note` |
| `speak` | **Speak Text** | `text` |
| `showAlert` | **Show Alert** | `title`, `message` |
| `wait` | **Wait** | `seconds` |
| `sendMessage` | **Send Message** — *guarded* | `to`, `body` |
| `addCalendarEvent` | **Add New Event** — *guarded* | `title`, `start`, `end` |
| anything else | **nothing** — skip silently | — |

**For the two guarded actions**, the `confirm` flag must be honoured:

```
If  Dictionary Value "confirm" is true
    Show Alert "JARVIS wants to send a message to <to>. Allow?"  → Cancel / OK
    If Cancel → skip this action, log it as refused
Run Send Message
```

**6. End Repeat**

**7. Build the results batch** — use **Repeat with Each** over `actions` again, or simpler: a single **Dictionary** with `v`, `planId`, `results`, where each result is `{action, ok:true, at: <Current Date ISO 8601>}`. 

**8. Get Contents of URL**
- URL: `<base>/results`
- Method: **POST**
- Request Body: **JSON** → the dictionary from step 7
- Header: `Content-Type: application/json`

**9. Show Notification** "JARVIS ran N actions"

## Step 4 — Build the "JARVIS Nightly" Shortcut

This is the learning loop. It runs nightly and leaves a written record JARVIS can read on next launch.

**1. Get Current Date** → format as ISO 8601

**2. Get Contents of URL** → `<base>/results` → Method **GET** (pull yesterday's batch if the Run shortcut didn't clean up)

**3. Get your own facts**
- **Get Battery Level**
- **Get Focus** (current Focus mode)
- **Get Calendar Events** (today) → count
- **Get Reminders** (due today) → count

**4. Build a results dictionary:**

```json
{
  "v": 1,
  "device": "iphone",
  "planId": "<from step 2, or 'nightly'>",
  "results": [
    { "action": "nightlyCheck", "ok": true, "detail": "battery 82, focus Work, 3 events, 4 reminders", "at": "<ISO date>" }
  ]
}
```

**5. Get Contents of URL** → `<base>/results` → Method **POST** → JSON body above

**6. Automate it:** Shortcuts app → **Automation** tab → **+** → **Time of Day** → 23:30, Daily → **Run Immediately** (turn off "Ask Before Running")

That's the whole loop: Shortcuts writes facts, JARVIS reads them at next launch, merges them into its learning store, and they surface in later answers.

---

## Step 5 — Send a plan from JARVIS

In JARVIS type:

```
plan: setFocus Work | openApp Calendar | createReminder "Chase vehicle 2 insurance" | logExpense 200 insurance "monthly accrual"
```

JARVIS validates every action against the registry, refuses anything unknown, adds `confirm` flags automatically, and offers **Send to Shortcuts** — which opens `shortcuts://run-shortcut?name=JARVIS Run` with the plan as text input. From there the Shortcut executes it.

**The pipe is the separator. Quote any argument containing spaces.**

---

## The protocol

Full schemas live in `actions.json`; a valid example is in `sample-plan.json`.

```json
{
  "v": 1,
  "id": "pln_20261030_0420_k7m2",
  "created": "2026-10-30T04:20:00Z",
  "expires": "2026-10-30T05:20:00Z",
  "intent": "Start the rental workday",
  "actions": [
    { "id": "a1", "name": "setFocus", "args": { "mode": "Work" }, "confirm": false }
  ]
}
```

### Hard rules the Shortcut must enforce

1. **Never** run an action absent from the registry.
2. `confirm: true` → explicit tap, every time, no exceptions.
3. Stop the plan on first failure.
4. Refuse a plan whose `expires` is in the past.
5. Refuse more than 10 actions.
6. Record a result for every action, including skipped and refused ones.

### Effect classification

| Class | Examples | Gate |
|---|---|---|
| No side effect | `speak`, `showAlert`, `wait` | none |
| Reversible | `setFocus`, `openApp`, `openURL`, `createReminder`, `createNote`, `logExpense` | log only |
| **Irreversible** | `sendMessage`, `addCalendarEvent`, `runShortcut` | **confirm required** |

---

## Mode C — zero infrastructure fallback

If you'd rather not run a Worker, skip `Get Contents of URL` entirely:

1. Make the first action of `JARVIS Run` be **Shortcut Input** → **Get Dictionary from Input**
2. JARVIS's **Send to Shortcuts** button already passes the plan as text via the `shortcuts://` URL scheme
3. Skip the results POST at the end; instead **Add to Text File** in iCloud Drive

You lose the nightly write-back (JARVIS can't read iCloud Drive), so learning stays manual — but the plan never leaves your phone, which is the strongest privacy of the three modes.

---

## Mode D — zero infrastructure, zero accounts (recommended if you want it working today)

Mode A needs a Cloudflare account. Mode D needs nothing at all: the plan travels inside a URL, and the results come back by paste.

### Send the plan

No settings, no mailbox. JARVIS's **Send to Shortcuts** button posts the plan to the mailbox *if configured*, and **always** hands it to Shortcuts via the URL scheme:

```
shortcuts://run-shortcut?name=JARVIS%20Run&input=text&text=<url-encoded plan JSON>
```

The Shortcut receives the plan as **Shortcut Input**, not from the network.

### Build the one Shortcut (8 actions)

1. **Get Dictionary from** → *Shortcut Input*
2. **If** `id` is empty → **Stop**
3. **Get Dictionary Value** for key `actions` → **Repeat with Each**
4. Inside: **Get Dictionary Value** `name` → **If** branches (same table as Mode A)
5. Guarded actions (`sendMessage`, `addCalendarEvent`, `runShortcut`) → **Show Alert → Choose from Menu → Cancel / Send**
6. **End Repeat**
7. **Ask for Input** (default: *nothing failed*) → optional result note for the log
8. **Add to Text File** → iCloud Drive/JARVIS/log.txt, **Append**, with a line per action: `setFocus ok 2026-10-30 08:00`

### Close the learning loop by paste

When you want JARVIS to absorb what happened, open `iCloud Drive/JARVIS/log.txt`, copy the lines, and in JARVIS type:

```
import: setFocus ok 2026-10-30 08:00
sendMessage failed user refused
logExpense ok 2026-10-30 08:05
```

Or paste a whole JSON batch:

```
import: {"v":1,"results":[{"action":"setFocus","ok":true,"at":"2026-10-30T08:00:00Z"}]}
```

JARVIS merges each line into its learning store as `Automation log: setFocus succeeded at 2026-10-30 08:00.`, and **dedupes** — importing the same log twice adds nothing the second time.

| | Mode A (Worker) | Mode C (scheme only) | Mode D (paste) |
|---|---|---|---|
| Account required | Cloudflare | none | **none** |
| Plan leaves device | yes | **no** | **no** |
| Automatic nightly write-back | yes | no | manual paste |
| Setup time | ~10 min | ~3 min | **~3 min** |

### One-link configuration

If you do deploy a mailbox, you can skip Settings entirely — open the app with the endpoint in the query string:

```
https://masteryoda224.github.io/Jarvis/?sync=https://your-worker.workers.dev/SECRET
```

JARVIS reads `?sync=`, saves it permanently to the device, and syncs results on every launch from then on.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"error":"not found"}` | SECRET path wrong or missing | Re-copy the full URL including the secret segment |
| `No plan waiting` | Plan TTL expired (1 hour) | Re-send from JARVIS |
| Plan runs nothing | `name` values don't match the registry keys exactly | Compare against `actions.json`; they're case-sensitive |
| Results never appear in JARVIS | Sync endpoint not saved, or CORS blocked | Confirm the URL returns JSON in Safari, then re-check Settings |
| JARVIS ignores a result | Duplicate `action` + `at` already merged | Expected — dedupe is intentional |

## What this layer cannot do

- **Tap inside other apps.** No confirmed automation can; only an AccessibilityService on Android or a jailbreak can. This layer drives *Shortcuts actions*, which is the sanctioned surface on iOS.
- **Run in the background indefinitely.** Automations fire on triggers; there is no daemon.
- **Learn without review.** The nightly job writes facts; JARVIS merges them as memory. It never rewrites its own logic — deliberate, so every behaviour stays auditable.
