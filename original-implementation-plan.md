# BC250 Performance Profile Plugin — MVP Implementation Spec

A Decky Loader plugin for the AMD BC-250 that exposes a notched **max-clock
slider** in the QAM panel. Moving the slider sets the GPU's maximum clock live
(mid-game, no restart) by capping it through the **stock** `cyan-skillfish-
governor` over its existing system D-Bus interface. No governor changes are
required for this MVP.

The slider position *is* the value: each notch is a max-frequency in MHz, the
selected MHz is shown live, and the **rightmost notch is the default** (capping at
the configured ceiling = effectively uncapped). Ticking left lowers the ceiling
for a quieter/cooler profile. The last selection is persisted and re-applied on
load.

This is a handoff spec for an implementing model. It assumes no prior sight of the
governor source; the facts it depends on are stated inline.

---

## 1. What the MVP does (and does not)

**Does:**
- Shows a horizontal notched slider in the Decky QAM panel. Notches are
  max-clock frequencies in MHz, **derived from the governor's own config** (§5).
- Displays the selected MHz value live as the slider moves.
- Rightmost notch = the config's effective default ceiling (no effective cap).
- Selecting a notch applies that ceiling live via one D-Bus `SetRange` call.
- **Persists the last selection** and re-applies it on plugin load (§4.4).
- **Optionally** shows a live readout of GPU/CPU temperatures and current GPU clock
  (§10) — all read from userspace, no governor changes needed.
- Surfaces a clear disabled state with a reason when the governor is unreachable.

**Does NOT (explicit non-goals — do not implement):**
- No per-notch voltage curves. All notches share the one curve already in the
  governor's config; they differ only in clock ceiling. (Per-profile curves are a
  later phase needing a governor patch; see §8.)
- No separate preset file. Notches come from the governor TOML (§5).
- No named notches. Labels are the MHz values.
- No `GetState` readback from the governor. Persistence tracks the plugin's *own*
  last selection; it does not read live governor state (see §8 stale-state note).
- No crash-recovery / revert guard. A max cap is a strict de-rating of the
  already-validated default curve — it only lowers the ceiling and never changes
  voltages — so a persisted cap cannot boot-lock the box. (This safety argument is
  specific to the cap-only MVP; it does **not** survive into the v2 curve-apply
  feature — see §8.)
- No in-plugin curve editor. Curve setup is done by editing the governor TOML in
  desktop mode, outside this plugin.
- No writing to `/etc`. The plugin **reads** the governor config (to derive
  notches) and writes only its own small state file (§4.4).
- No minimum-clock floor. Notches cap the maximum only (`min` arg always 0).

---

## 2. The governor interface this depends on

The stock `cyan-skillfish-governor` (smu branch, package
`cyan-skillfish-governor-smu`) exposes a **system**-bus D-Bus service when
`dbus.enabled = true`:

- Service:   `com.cyan.SkillFishGovernor`
- Object:    `/com/cyan/SkillFishGovernor`
- Interface: `com.cyan.SkillFishGovernor.PerformanceMode`

Method used:

- `SetRange(u32 min, u32 max)` — set the operating clock range in MHz.
  `SetRange(0, cap)` caps the **maximum** at `cap` while keeping adaptive control
  (the GPU still clocks down at idle). The plugin always passes `min = 0`.
- **Do not use `SetFixedFrequency`** — it pins the clock and disables idle
  downclock, which is wrong for a power-profile slider.

`SetRange` validates `max` against the governor's **allowed range**, which is
`[lowest safe-point frequency, highest safe-point frequency]` from the loaded
config — not a hardware constant. A `max` outside that span is rejected, so all
notch frequencies must fall inside it (guaranteed by the §5 derivation).

The D-Bus policy permits the `default` context to send, but the plugin backend
runs as root anyway and calls via `busctl --system`.

Verified working (caps clocks live under load):
```
busctl --system call com.cyan.SkillFishGovernor /com/cyan/SkillFishGovernor \
  com.cyan.SkillFishGovernor.PerformanceMode SetRange uu 0 1600
```

---

## 3. Architecture

- **Frontend** (`src/index.tsx`, TypeScript/React, `@decky/ui` + `@decky/api`):
  the slider and status text. Calls backend methods via `callable`. Holds the
  selected notch index in React state.
- **Backend** (`main.py`, Python, runs as **root** via the `_root` flag): owns all
  privileged work — running `busctl`, detecting governor availability, parsing the
  governor config to derive notches, persisting the last selection, and
  re-applying it at session start.
- The frontend never touches D-Bus or the filesystem directly; everything routes
  through backend RPC.

---

## 4. Backend (`main.py`)

Implement a `Plugin` class with async methods callable from the frontend.

### 4.1 `get_status() -> dict`

Called on panel mount.

```python
{
  "available": bool,         # is the governor reachable?
  "reason": str | None,      # human-readable why-not when unavailable
  "notches": [int, ...],     # ascending MHz; last element is the default ceiling
  "current_index": int       # resolved from persisted value, else default (last)
}
```

Steps:
1. **Detect governor presence.** Confirm the bus name exists on the system bus,
   e.g. `busctl --system status com.cyan.SkillFishGovernor` (exit 0 = present) or
   scan `busctl --system list`. Presence also implies `dbus.enabled = true`. If
   absent → `available: False` with a reason like "GPU governor service not
   running, or its D-Bus interface is disabled."
2. **Derive notches** from the governor config (§5).
3. **Resolve `current_index`** from the persisted value (§4.4), validated against
   the freshly-derived notch list; fall back to the default (last) index if the
   persisted value is missing or no longer a valid notch.

### 4.2 `apply_cap(freq_mhz: int) -> dict`

```python
{ "ok": bool, "error": str | None }
```

1. Validate `freq_mhz` is one of the current `notches` values (reject otherwise).
2. Run `busctl --system call ... SetRange uu 0 {freq_mhz}` via
   `asyncio.create_subprocess_exec` (do not block the loop).
3. On exit 0: **persist** `freq_mhz` (§4.4) and return `ok: True`. Else return
   `ok: False` with stderr in `error` and do not persist.

### 4.3 `_main` — re-apply on load

In the plugin's `_main` (runs when the plugin loads at session start, before the
panel is opened):
1. Detect governor presence; if unavailable, skip silently (the panel will surface
   it later).
2. Derive notches, read the persisted value, validate it against the notch list.
3. If valid, apply it via `SetRange(0, value)` so the saved profile is active from
   session start. If invalid/missing, do nothing (the box is already at its config
   default).

### 4.4 Persistence

Store a tiny state file in the plugin settings dir
(`decky.DECKY_PLUGIN_SETTINGS_DIR/state.json`), e.g. `{ "last_cap_mhz": 1600 }`.
This is the plugin's own last selection — not governor state. Safe to re-apply
unconditionally because a cap only de-rates the already-validated curve.

### 4.5 Notes
- Log via `decky.logger`.
- Never raise to the frontend; return the dicts so the UI can render failures.

---

## 5. Notch derivation (no separate preset file)

Notches come entirely from the governor TOML, read at plugin load. Default path:
`/etc/cyan-skillfish-governor-smu/config.toml`. Read-only.

1. Parse `[[safe-points]]` → the set of `frequency` values (MHz).
2. Compute the **effective default range**:
   - `eff_min` = `[frequency-range].min` if present, else the lowest safe-point.
   - `eff_max` = `[frequency-range].max` if present, else the highest safe-point.
   (The governor's boot state is governed by `[frequency-range]`, which may sit
   *below* the top safe-point. Pinning the rightmost notch to `eff_max` makes
   "rightmost == boot default" exact and stops the slider exceeding the ceiling the
   curve author chose.)
3. Notch set = the safe-point frequencies within `[eff_min, eff_max]`, plus
   `eff_min` and `eff_max` themselves (deduped). Sort ascending. The last element
   is `eff_max` — the default ceiling and rightmost notch.
4. **Count cap is optional.** On a controller the slider steps notch-by-notch
   (directional press, hold to repeat), so a large detent count is not a usability
   problem the way analog landing would be — use every in-range safe-point by
   default. A `MAX_NOTCHES` knob (subsample evenly, always keep first and last) is
   available if wanted but defaults to off/unlimited.
   - **Confirm during hardware testing:** verify `@decky/ui` `SliderField` actually
     steps one notch per directional press and auto-repeats on hold. If instead it
     moves proportionally (not snapping per-press), reconsider enabling
     `MAX_NOTCHES` so dense detents don't become fiddly.

**Parsing.** Use Python's `tomllib` (stdlib, read-only, 3.11+) — the plugin never
writes the governor config, so read-only is sufficient. Confirm the Python version
available to Decky plugins on the target; fall back to the `tomli` package if it's
older. The governor accepts both hyphenated and underscored section names
(`frequency-range` / `frequency_range`); read the hyphenated canonical form and, as
cheap insurance, fall back to the underscored alias. Within `[[safe-points]]` the
keys are `frequency` and `voltage` (integers, MHz and mV); the plugin only needs
`frequency`. See Appendix A for real fixtures and worked derivations.

To change which clocks are selectable, the user edits the curve / `[frequency-
range]` in the governor TOML (desktop mode). One source of truth.

---

## 6. Frontend (`src/index.tsx`)

- On mount, call `get_status()`; store `notches`, `current_index`, `available`,
  `reason`.
- If `available` is false: render `reason` and a disabled control. Never render an
  interactive slider that silently does nothing.
- Render a notched slider (`@decky/ui` `SliderField`, `notchCount = notches.length`,
  `value` = selected index). Confirm exact prop names (`notchCount`, `value`,
  `onChange`, optional `notchTicksVisible`) against the installed `@decky/ui`.
- **Show the selected MHz live** — e.g. as the field label / a value readout that
  updates with the position (`notches[index]` MHz). Per-notch text labels are
  optional and usually omitted; the live readout carries the meaning.
- **Initial value = `current_index`** from `get_status` (persisted-or-default).
  This matches the state the backend re-applied in `_main`.
- **Apply on release.** A notched slider snaps to discrete indices; apply when the
  index settles. If `onChange` fires continuously during a drag, debounce ~300 ms
  and apply only the final index so dragging across notches makes one `SetRange`
  call, not several.
- On apply, call `apply_cap(notches[index])`. On `ok: false`, surface the error
  (e.g. `toaster`) and leave the slider where it is.

---

## 7. `plugin.json` and packaging

```json
{
  "name": "BC250 Performance Profiles",
  "author": "<you>",
  "flags": ["_root"],
  "api_version": 1,
  "publish": {
    "tags": ["bc250", "performance", "gpu"],
    "description": "Set the BC-250 GPU max clock live via a notched slider, driving the cyan-skillfish governor.",
    "image": ""
  }
}
```

- `_root` is required: the backend runs `busctl --system` and reads `/etc`.
- Add `"debug"` to `flags` during development only.
- Build with the standard Decky template toolchain (`@decky/rollup`, `pnpm build`).
  Frontend deps: `@decky/api`, `@decky/ui`, `react-icons`.

---

## 8. Known limitations to document for users (and seams for v2)

- **Shared curve.** All notches use the same voltage-at-a-given-clock from the
  governor's one config curve; they differ only in clock ceiling. Per-notch curves
  require the governor `ApplyProfile` patch (v2).
- **Notch set is curve-driven.** Selectable clocks come from the config's
  safe-points and `[frequency-range]`. To change them, edit the governor TOML.
- **Stale state on external change.** Persistence re-asserts the plugin's last
  selection on load, so the slider matches reality at session start. But with no
  `GetState`, if the governor is changed by another tool *while the panel is open*,
  the position can diverge until reload; selecting any notch re-asserts a known
  state. Acceptable for MVP.
- **rpm-ostree / Bazzite.** Both the governor (COPR-layered) and Decky can need
  reinstatement after image updates. The §4.1 availability check surfaces a dead
  governor cleanly rather than failing opaquely.

V2 seams: `apply_cap` is where `ApplyProfile(toml_blob)` slots in once the governor
supports live full-profile application; notches gain an associated curve; a real
`GetState` read syncs the slider position when external tools change governor
state (the clock readout doesn't need it — §10.2 reads the clock from userspace).
**Important:** once v2 persists full *curves* rather than caps, the cap-only
safety argument no longer holds — a persisted aggressive undervolt can boot-lock —
so the unconfirmed-apply revert guard must be added on the curve-persistence path
at that point.

---

## 9. Test checklist

- [x] `SetRange uu 0 <cap>` caps clocks under sustained load (FurMark, verified).
- [ ] Rightmost notch (`SetRange uu 0 <eff_max>`) leaves the box at its default
      ceiling, indistinguishable from a fresh boot.
- [ ] No perceptible frametime hitch switching notches *in an actual game*.
- [ ] `SliderField` steps one notch per directional press and auto-repeats on hold
      (decides whether `MAX_NOTCHES` is needed — §5.4).
- [ ] Persistence: select a lower notch, reload the plugin (or restart the
      session) → the saved cap is re-applied and the slider opens on it.
- [ ] Persistence fallback: edit the TOML so the persisted freq is no longer a
      valid notch → plugin falls back to the default (rightmost), no error spam.
- [ ] Notch derivation: `[frequency-range].max` below the top safe-point →
      rightmost == that max, no notch above it.
- [ ] Governor stopped (`systemctl stop`) → panel shows unavailable, control
      disabled, reason correct; `_main` skips re-apply without error.
- [ ] `dbus.enabled = false` → same unavailable handling.
- [ ] Governor service restart while a lower cap is active → governor resets to its
      config default; the plugin's next load re-applies the persisted cap.

---

## 10. Optional: live telemetry readout

A read-only telemetry strip in the same panel, below the slider. Pure reads, no
privileged writes, fully independent of the slider/governor control path — if it
fails it shows nothing and the slider is unaffected. Treat as optional; cut it for
a minimal first build.

### 10.1 Temperatures (in scope for MVP if telemetry is built)

Sourced from sysfs hwmon, independent of the governor:
- **GPU:** the amdgpu hwmon node for the card — `temp*_input` (edge / junction;
  millidegrees C, divide by 1000). Discover by walking `/sys/class/hwmon/hwmon*`
  and matching the one whose `name` is `amdgpu` and whose device is the BC-250 GPU
  (PCI `0000:01:00.0` per the governor's bus assumption).
- **CPU:** the `k10temp` hwmon node (Zen 2) — `temp*_input` for Tctl/Tdie. Discover
  by matching `name == "k10temp"`.
- Do **not** hardcode `hwmonN` indices; they're not stable across boots. Resolve by
  `name` at load.

### 10.2 Current GPU clock (readable in userspace — no patch needed)

The live GPU clock is exposed to userspace and reflects the real running frequency
regardless of the SMU force (confirmed: amdgpu_top and FurMark read it in realtime
on the BC-250). It does **not** require a governor `GetState` patch. Candidate
sources for the backend, in order of simplicity:
1. **amdgpu hwmon `freq1_input`** (Hz → MHz) on the same amdgpu hwmon node resolved
   in §10.1, if exposed. Trivial integer read.
2. **`gpu_metrics` sysfs blob** (`/sys/class/drm/cardN/device/gpu_metrics`) —
   contains `current_gfxclk`, but is a versioned binary struct, so it needs
   version-aware unpacking.
3. **`amdgpu_top`** in JSON/dump mode (confirm the exact flag), parsed for the gfx
   clock field — robust (it already does the version-aware parsing) but a soft
   dependency on amdgpu_top being installed.

`pp_dpm_sclk` is **not** a reliable source here: it lists discrete DPM levels with
an active marker, which may not track an arbitrary SMU-forced clock. Use a live
sensor source (1 or 2) instead.

**Verify on hardware** which native source (1 or 2) reports the live forced value,
using amdgpu_top's reading as ground truth, and ship that. Optionally fall back to
shelling out to amdgpu_top (3) when the native source is absent.

### 10.3 Poll lifecycle
- Backend method
  `get_telemetry() -> { "gpu_temp_c": float|None, "cpu_temp_c": float|None, "gfx_clock_mhz": int|None }`
  reading the resolved hwmon / clock paths. Return `None` per field on read failure
  rather than raising.
- Frontend polls only **while the QAM panel is open** (e.g. a `setInterval` started
  on mount, cleared on unmount), at ~1–2 s. Do not poll when the panel is closed —
  no value in spending cycles on a hidden readout during a game.
- Reads are cheap; keep the interval conservative anyway.

### 10.4 Telemetry tests
- [ ] hwmon resolution by `name` finds the correct amdgpu and k10temp nodes; survives
      a reboot that renumbers `hwmonN`.
- [ ] Temps read and display; a removed/unreadable sensor shows blank, not an error,
      and doesn't disturb the slider.
- [ ] Clock readout: the chosen native source tracks the SMU-forced clock — cross-
      check against amdgpu_top while a cap is applied; the displayed MHz should drop
      to (or below) the cap under load.
- [ ] Polling stops when the panel closes (no lingering interval / backend calls).

---

## 11. Cross-distro / platform notes (Bazzite immutable + CachyOS Arch)

The frontend is OS-agnostic — it talks to Steam's UI, not the OS, so it runs
wherever Decky runs. Every portability concern is in the backend and its
environment. The asymmetry: Bazzite (rpm-ostree, Fedora, SELinux-enforcing) carries
the special constraints; CachyOS (mutable Arch) is permissive, so most items below
are about making the Bazzite side work.

- **Detect via the D-Bus bus name, not the unit name or `systemctl`.** The AUR and
  COPR packages of the governor share the same upstream `.service` and bus name, but
  checking the bus name (§4.1) is packaging-agnostic and sidesteps any unit-name or
  path differences. The MVP also never calls `systemctl` (no restart path), which
  both keeps it portable and minimizes the SELinux surface below.
- **Config path is consistent — keep it overridable anyway.** Both packages install
  `/etc/cyan-skillfish-governor-smu/config.toml`. Make it a single constant the user
  can override rather than scattering the literal, in case a future package or a
  custom build differs.
- **The plugin writes only to home/Decky dirs.** Persistence (§4.4) and plugin files
  live under `DECKY_PLUGIN_SETTINGS_DIR` / `~/homebrew`, mutable on both. The plugin
  only *reads* `/etc`. So OS immutability is a non-issue — and `/etc` is writable on
  rpm-ostree regardless; the plugin just doesn't need it to be.
- **sysfs/hwmon is kernel-defined, identical on both.** Resolve by driver `name`
  (§10.1) — `amdgpu` is the only GPU hwmon on the single-GPU BC-250, so a PCI match
  is belt-and-suspenders. Which clock attributes exist (`freq1_input`, `gpu_metrics`)
  is decided by **kernel version, not distro**, so probe at runtime (§10.2). Prefer
  the native sysfs clock read over shelling out to amdgpu_top, so the plugin doesn't
  depend on amdgpu_top being installed (less predictable across the two distros).
- **SELinux is the Bazzite-specific risk — test it.** The root backend running
  `busctl` and reading `/etc` executes under SELinux enforcement on Bazzite. Decky's
  loader has SELinux handling, but plugin subprocesses can still hit AVC denials
  depending on inherited context. Verify explicitly: run the cap + telemetry actions,
  then `sudo ausearch -m AVC -ts recent` (or grep `journalctl` for `denied`). If
  denied, a custom policy module or an alternate mechanism may be needed. CachyOS has
  no enforcing LSM here, so this class of bug won't appear there — test on Bazzite
  specifically.
- **rpm-ostree update churn (Bazzite only).** As in §8, the governor (COPR-layered)
  and Decky itself can need reinstatement after image updates; the §4.1 availability
  check surfaces a missing governor cleanly. CachyOS rolling has no equivalent.
- **Decky runtime Python.** `tomllib` needs 3.11+. This is a Decky-runtime question
  (consistent across distros if Decky bundles its own Python; both system Pythons are
  well past 3.11 regardless). Confirm once; fall back to `tomli` if older.
- **Install is user-side, not plugin-side.** Bazzite: `ujust setup-decky` + COPR
  governor. CachyOS/Arch: upstream Decky installer or AUR + AUR governor. The plugin
  assumes both Decky and a running governor are present and degrades cleanly if not
  (§4.1). It must never attempt to install or manage the governor.
- **Hardware is board-determined.** PCI addresses and hwmon presence come from the
  BC-250 itself, identical on both systems.

---

## Appendix A — Real config fixtures and worked notch derivations

These are the two configs the governor repo ships (smu branch). They're useful as
parser fixtures and as assertion targets: between them they cover both derivation
paths (with and without `[frequency-range]`) and the high-detent case. The plugin
only reads `[[safe-points]]` and `[frequency-range]`; every other section below
must be parsed-over and ignored.

### A.1 Fixture with `[frequency-range]` (exercises the clamp)

```toml
# us
[timing.intervals]
sample = 250
adjust = 100_000

[gpu-usage]
fix-metrics = true
method = "busy-flag"
flush-every = 10

[gpu]
set-method = "smu"

[dbus]
enabled = true

# Optional: set initial frequency range limits
[frequency-range]
min = 1000    # MHz
max = 1850    # MHz

[timing.ramp-rates]
normal = 1
burst = 50

[timing]
burst-samples = 60
down-events = 5

[frequency-thresholds]
adjust = 10

[load-target]
upper = 0.65
lower = 0.50

[temperature]
throttling = 85
throttling_recovery = 75

[[safe-points]]
frequency = 500
voltage = 700

[[safe-points]]
frequency = 1000
voltage = 800

[[safe-points]]
frequency = 1175
voltage = 850

[[safe-points]]
frequency = 1500
voltage = 900

[[safe-points]]
frequency = 1600
voltage = 910

[[safe-points]]
frequency = 1700
voltage = 920

[[safe-points]]
frequency = 1850
voltage = 930

[[safe-points]]
frequency = 2000
voltage = 960
```

**Expected derivation:**
- Safe-point freqs: `500, 1000, 1175, 1500, 1600, 1700, 1850, 2000`
- `eff_min = 1000` (frequency-range.min), `eff_max = 1850` (frequency-range.max)
- In-range safe-points: `1000, 1175, 1500, 1600, 1700, 1850` (500 dropped: below
  eff_min; 2000 dropped: above eff_max)
- **Notches** = `[1000, 1175, 1500, 1600, 1700, 1850]`; rightmost/default = `1850`.

### A.2 Fixture without `[frequency-range]` (exercises full-span + high detent count)

```toml
# us
[timing.intervals]
sample = 500
adjust = 200_000

[gpu-usage]
fix-metrics = true
method = "process"
flush-every = 10

[gpu]
set-method = "kernel"

[dbus]
enabled = true

[timing.ramp-rates]
normal = 1
burst = 50

[timing]
burst-samples = 60
down-events = 5

[frequency-thresholds]
adjust = 10

[load-target]
upper = 0.80
lower = 0.65

[temperature]
throttling = 85
throttling_recovery = 75

[[safe-points]]
frequency = 500
voltage = 700

[[safe-points]]
frequency = 1175
voltage = 700

[[safe-points]]
frequency = 1400
voltage = 750

[[safe-points]]
frequency = 1600
voltage = 800

[[safe-points]]
frequency = 1700
voltage = 850

[[safe-points]]
frequency = 1850
voltage = 900

[[safe-points]]
frequency = 2000
voltage = 950

[[safe-points]]
frequency = 2050
voltage = 975

[[safe-points]]
frequency = 2100
voltage = 1000

[[safe-points]]
frequency = 2125
voltage = 1015

[[safe-points]]
frequency = 2150
voltage = 1030

[[safe-points]]
frequency = 2200
voltage = 1050

[[safe-points]]
frequency = 2230
voltage = 1085

[[safe-points]]
frequency = 2300
voltage = 1110

[[safe-points]]
frequency = 2350
voltage = 1130
```

**Expected derivation:**
- No `[frequency-range]` → `eff_min = 500` (lowest safe-point),
  `eff_max = 2350` (highest safe-point).
- **Notches** = all 15 safe-points:
  `[500, 1175, 1400, 1600, 1700, 1850, 2000, 2050, 2100, 2125, 2150, 2200, 2230, 2300, 2350]`;
  rightmost/default = `2350`.
- This is the case that makes `MAX_NOTCHES` relevant (§5.4): 15 detents. Leave it
  uncapped unless hardware testing shows `SliderField` stepping makes that fiddly.

### A.3 Validation notes for the parser
- `[[safe-points]]` is a TOML array-of-tables; expect ≥1 entry. The governor itself
  rejects an empty array and requires voltage to be non-decreasing as frequency
  rises, but the plugin doesn't need to re-validate the curve — it only reads the
  `frequency` values. (A malformed curve would already prevent the governor from
  running, which the §4.1 availability check catches.)
- If `[frequency-range]` is present but only `min` or only `max` is set, fill the
  missing bound from the safe-point endpoints (lowest/highest frequency).
- Frequencies are plain integers; TOML underscore digit separators (`100_000`)
  appear in other sections but not in the safe-point/range values.

---

## Appendix B — References

Sources used in producing this spec. Items marked **[read]** were inspected
directly (cloned/parsed); others are canonical pointers to confirm details
against during implementation.

### Decky plugin development
- **Decky plugin template** — `https://github.com/SteamDeckHomebrew/decky-plugin-template` **[read]**
  Authoritative structure reference. Files that informed this spec:
  - `plugin.json` — the `flags: ["_root"]` mechanism that runs the Python backend
    as root (needed for `busctl --system` and reading `/etc`).
  - `main.py` — the `Plugin` class shape; backend methods are callable from the
    frontend; `decky.emit` for events; lifecycle hooks `_main` / `_unload` /
    `_migration`; `decky.logger`, `decky.DECKY_PLUGIN_SETTINGS_DIR`.
  - `src/index.tsx` — frontend RPC via `callable<[args], ret>("name")`; imports
    from `@decky/ui` (`PanelSection`, `PanelSectionRow`, etc.) and `@decky/api`.
- **Decky plugin dev docs / wiki** — `https://wiki.deckbrew.xyz/en/plugin-dev/getting-started`
  Canonical getting-started and API reference. Confirm `@decky/ui` `SliderField`
  props (`notchCount`, `notchLabels`, `notchTicksVisible`, `value`, `onChange`) and
  the `callable` / event API here against the installed versions.
- **`@decky/ui` / `@decky/api`** — npm packages (template pins `@decky/ui ^4.11.0`,
  `@decky/api ^1.1.3`). The source of truth for available UI components.

### Cyan Skillfish governor
- **Governor repo, `smu` branch** — `https://github.com/filippor/cyan-skillfish-governor/tree/smu` **[read]**
  The dependency this plugin drives. Files that informed this spec:
  - `README.md` — D-Bus interface reference (service/object/interface names,
    `SetRange` semantics), config schema, install paths.
  - `src/dbus.rs` — the actual `PerformanceMode` D-Bus methods (`Enable`,
    `Disable`, `SetFixedFrequency`, `SetRange`, `Enabled` property).
  - `src/config.rs` — config parsing/validation; `safe-points` and
    `frequency-range` handling; section-name aliases (`frequency-range` /
    `frequency_range`, `gpu-usage` / `gpu_usage`).
  - `src/gpu.rs` / `src/governor.rs` — confirms `allowed range` is derived from the
    safe-point endpoints and that `SetRange` keeps adaptive control.
  - `default-config.toml`, `config.toml` — the two fixtures reproduced in
    Appendix A.
- **Install sources** (for users, not the plugin build):
  - AUR — `https://aur.archlinux.org/packages/cyan-skillfish-governor-smu`
  - COPR (Fedora/Bazzite) — `https://copr.fedorainfracloud.org/coprs/filippor/bazzite/`
- **bc250-collective** — `https://github.com/bc250-collective/`
  Source of the SMU API the governor's `smu` backend builds on (credited in the
  governor README); background only — the plugin never touches SMU directly.

### BC-250 platform (deployment target)
- **bazzite-bc250** — `https://github.com/Canz2/bazzite-bc250`
  The Bazzite variant most BC-250 users run; the environment the plugin ships into.
- **Bazzite handheld/HTPC wiki** — `https://docs.bazzite.gg/Handheld_and_HTPC_edition/Handheld_Wiki/`
  Decky install (`ujust setup-decky`), QAM access, and the note that Decky may need
  reinstatement after image updates (relevant to §8's availability handling).
- **Bazzite Steam Gaming Mode** — `https://docs.bazzite.gg/Handheld_and_HTPC_edition/Steam_Gaming_Mode/`
  Confirms the controller-driven gamescope/gamepadUI context the slider runs in.

### Python
- **`tomllib`** — Python stdlib (3.11+), read-only TOML parser; the §5 parser
  choice. Fallback `tomli` (`https://pypi.org/project/tomli/`) for older runtimes.