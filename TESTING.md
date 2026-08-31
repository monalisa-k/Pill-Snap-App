# Field testing protocol — baseline validation

For validating the current build on a real phone with real pills, before any
algorithm changes. The counting engine (`src/vision/`) is frozen at commit
`03c3f59` so these results stay a clean baseline.

---

## Read this first: shoot with the stock Camera app

Photos captured **inside** Pill Snap are written to the app's cache directory
and are **not** saved to your camera roll. They disappear when the cache is
cleared, and there is no way to get them back.

That matters more than it sounds. The single most valuable thing to come out of
this round of testing is not the numbers — it is a **corpus of real photos with
known true counts**. With it, any future algorithm change can be re-run against
the exact same images and compared. Without it, every change needs a fresh
afternoon of shooting pills.

So for each test case:

1. Lay out the pills and **count them by hand** (twice — the ground truth has to
   be more reliable than the thing it is measuring).
2. Take the photo with your phone's **normal Camera app**. It lands in your
   camera roll permanently.
3. In Pill Snap, tap **Library** and pick that photo.

Both paths run identical counting code — the in-app camera resizes to 900px and
so does the library import — so nothing is lost by testing this way. Use the
in-app camera only to check that the capture flow itself works (step 2 below).

---

## 1. Run it on your phone

Requires Node 20 or newer, and your phone on the **same Wi-Fi** as your computer.

```bash
git clone https://github.com/monalisa-k/Pill-Snap-App.git
cd Pill-Snap-App
git checkout claude/pill-counter-app-bq8pm4
npm install
npm start
```

Install **Expo Go** from the App Store / Play Store, then:

- **iPhone** — point the built-in Camera app at the QR code in your terminal and
  tap the banner.
- **Android** — open Expo Go, tap *Scan QR code*, scan it.

Every native module this app uses ships inside Expo Go, so no custom dev build
is needed.

**If the QR does not connect** (corporate Wi-Fi, client isolation, VPN):

```bash
npx expo start --tunnel
```

Slower, but it routes around the network instead of needing a direct one.

Press `r` in the terminal to reload the app, `j` to open the debugger.

---

## 2. Check both flows work

Do this once before starting the real test matrix.

**Camera flow** — open the app, grant camera access, point at a few pills on a
plain surface, tap the shutter. You should get a "Counting…" spinner, then the
result screen with dots on the pills. Confirm the torch toggle works.

**Library flow** — tap **Library**, grant photo access, pick any photo of pills.
Same result screen.

**Correction flow** — on a result, pinch to zoom into a clump, tap a dot (it
should disappear and the count drop by one), tap an empty pill (a green dot
appears, count goes up). Tap **Undo edits** to reset, then **Save**. Check the
entry appears under **History**.

If any of these misbehave, stop and tell me — that is a UI bug to fix before
the accuracy numbers mean anything.

---

## 3. What to record

The result screen gives you four of the five things you need:

| What | Where on screen |
| --- | --- |
| Predicted count | the big number |
| Confidence | the coloured badge, top right |
| Warnings | the messages below the count |
| Diagnostics | the small grey line: shapes found, clumps split, milliseconds |

The badge shows both the **band** and the **raw score to two decimals**, e.g.
*High confidence · 0.97*. Record both. The bands map to:

| Badge | Score range |
| --- | --- |
| **High confidence** (green) | ≥ 0.90 |
| **Worth a check** (amber) | 0.70 – 0.89 |
| **Needs your review** (red) | < 0.70, or any blocking warning |

The app *acts* on the band, so the band decides behaviour — but the raw score
is what tells you whether the thresholds sit in the right place. A run where
every Tier A photo lands at 0.99 and every miss lands at 0.4 is well
calibrated; one where correct and incorrect counts both cluster near 0.9 means
the cutoff is in the wrong spot even if the pass/fail tally looks fine.

Fill in `test-log.csv`. The columns that matter most:

- `actual_count` — your hand count. Everything depends on this being right.
- `predicted_count` — the number **before** you correct anything.
- `exact_match` — `yes` / `no`, comparing those two.
- `confidence_numeric` — the two-decimal score from the badge.
- `confidence_band` — `high` / `medium` / `low`.
- `warnings` — semicolon-separated. Short forms are fine: `glare`, `blurry`,
  `clustering`, `edge`, `contrast`, `fused`, `ambiguous`, `sizes`, `sparse`.
  Put `none` rather than leaving it blank, so a clean run is distinguishable
  from one you forgot to fill in.
- `photo_filename` — so a photo can be traced back to its row later.

---

## 4. Suggested test matrix

Ordered so the most informative cases come first. Roughly 3–4 photos per row is
enough to see a pattern; ~30 photos total is a solid baseline.

### Tier A — the conditions the app coaches you toward

These should be essentially perfect. Any miss here is a real problem worth
stopping for.

| # | Setup |
| --- | --- |
| A1 | 10–15 white tablets, well spread, dark plate, even daylight |
| A2 | 30–40 white tablets, well spread, dark plate, even daylight |
| A3 | 10–15 dark tablets on a white plate |
| A4 | 10–15 coloured capsules on a white plate |
| A5 | Mixed sizes deliberately — two different medications in frame |

### Tier B — realistic imperfection

Where real-world behaviour will diverge most from the synthetic benchmark.

| # | Setup |
| --- | --- |
| B1 | Pills touching in twos and threes |
| B2 | One tight clump plus several loose pills |
| B3 | Indoor evening light, no flash |
| B4 | **With flash on** — expect a glare warning |
| B5 | Deliberately shaky/soft photo — expect a blur block |
| B6 | Shot at ~30° instead of straight down |
| B7 | Pills running off the edge of the frame — expect an edge warning |
| B8 | Glossy or patterned surface (wood grain, marble) |

### Tier C — the known-hard cases

Expect misses here. What is being tested is **whether it flags them**, not
whether it gets them right. A wrong count that arrives flagged is a pass; a
wrong count wearing a green badge is the failure that matters.

| # | Setup |
| --- | --- |
| C1 | 50+ pills poured into a dense pile |
| C2 | Capsules lying flush side by side |
| C3 | Pills overlapping / stacked on each other |
| C4 | White pills on a white surface |

---

## 5. What the numbers should look like

From the synthetic benchmark, for comparison:

| Tier | Exact scenes | Per-pill accuracy |
| --- | --- | --- |
| Spread out | 24/24 (100%) | 100% |
| Touching | 24/24 (100%) | 100% |
| Packed raft | 16/24 (67%) | 89% |

Real photos will be worse — synthetic pills have no shadows, no motion blur, no
depth of field, and perfectly uniform colour. Tier A landing anywhere near 100%
would be a good result.

The two things worth watching hardest:

1. **Anything green and wrong.** The benchmark asserts every badly-wrong scene
   arrives flagged. If a real photo returns a confidently wrong number, that is
   the most important finding of the whole exercise and worth reporting on its
   own.
2. **Anything red and right.** Over-flagging is much cheaper than under-flagging,
   but if half of Tier A comes back amber the thresholds are miscalibrated and
   users will start ignoring the badge.

---

## 6. Sending results back

`test-log.csv` plus the photos is ideal — with the photos I can replay each case
against the pipeline directly, see which stage went wrong, and verify any fix
against your real images instead of synthetic ones.

If the photos are too large to share, the CSV alone is still useful; the
`warnings` and `shapes_found` columns usually narrow down the stage at fault.
