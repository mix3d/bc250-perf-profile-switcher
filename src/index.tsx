import {
  ConfirmModal,
  DialogBody,
  DialogButton,
  DialogButtonPrimary,
  DialogButtonSecondary,
  DialogControlsSection,
  DialogControlsSectionHeader,
  DialogFooter,
  DialogHeader,
  DropdownItem,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  SliderField,
  Spinner,
  TextField,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, fetchNoCors, toaster } from "@decky/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaBolt, FaExclamationTriangle, FaPencilAlt, FaSave, FaTrash } from "react-icons/fa";

type DisplayMode = "off" | "minimal" | "histogram";

interface Status {
  available: boolean;
  reason: string | null;
  notches: number[];
  current_freq_mhz: number;
}

interface Telemetry {
  gpu_temp_c: number | null;
  cpu_temp_c: number | null;
  gfx_clock_mhz: number | null;
  cpu_clock_mhz: number | null;
  gpu_power_w: number | null;
  gpu_load_pct: number | null;
  cpu_usage_pct: number | null;
}

interface Profile {
  id: string;
  name: string;
  min_freq_mhz: number;
  max_freq_mhz: number;
  load_min: number;
  load_max: number;
  temp_throttling: number;
  temp_recovery: number;
  use_toml_steps?: boolean;
  cap_freq_mhz?: number;
}

interface ConfigDefaults {
  min_freq_mhz: number;
  max_freq_mhz: number;
  load_min: number;
  load_max: number;
  temp_throttling: number;
  temp_recovery: number;
}

type TelemetryKey = keyof Telemetry;

const BUFFER_SIZE = 60;
const SPARK_HEIGHT = 40;

const getStatus = callable<[], Status>("get_status");
const applyCap = callable<[number], { ok: boolean; error: string | null }>("apply_cap");
const getTelemetry = callable<[], Telemetry>("get_telemetry");
const getHistory = callable<[], Telemetry[]>("get_history");
const setHistoryEnabled = callable<[boolean], void>("set_history_enabled");
const getDebugInfo = callable<[], Record<string, string | number | null>>("get_debug_info");
type GovernorStatus = "compatible" | "not_installed" | "outdated" | "stale_service" | "dbus_disabled" | "config_unreadable" | "unknown";
const getGovernorVersion = callable<[], { version: string | null; status: GovernorStatus; min_version: string; config_path: string }>("get_governor_version");
const getConfigDefaults = callable<[], ConfigDefaults>("get_config_defaults");
const listProfiles = callable<[], { profiles: Profile[]; active_id: string | null; corrupt: boolean }>("list_profiles");
const resetProfiles = callable<[], { ok: boolean; error: string | null }>("reset_profiles");
const saveProfile = callable<[Profile], { ok: boolean; error: string | null; id: string | null }>("save_profile");
const deleteProfile = callable<[string], { ok: boolean; error: string | null }>("delete_profile");
const setActiveProfile = callable<[string], { ok: boolean; error: string | null }>("set_active_profile");
const updatePlugin = callable<[], { started: boolean; error?: string }>("update_plugin");

const rowHead: React.CSSProperties = {
  fontSize: "0.75em",
  fontWeight: "bold",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const sectionHead = (mt: string): React.CSSProperties => ({
  ...rowHead,
  marginBottom: "4px",
  marginTop: mt,
});

const dimLabel: React.CSSProperties = { fontSize: "0.75em", opacity: 0.55 };

const metricLabel: React.CSSProperties = { ...dimLabel, width: "44px", flexShrink: 0 };

const cellValue: React.CSSProperties = { fontSize: "0.85em" };

const valueStyle: React.CSSProperties = { ...cellValue, whiteSpace: "nowrap", width: "64px", flexShrink: 0 };

const graphContainer: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  borderRadius: "4px",
  overflow: "hidden",
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
  backgroundSize: "8px 8px",
  backgroundColor: "rgba(0,0,0,0.2)",
};

function Sparkline({ data, height = SPARK_HEIGHT }: { data: number[]; height?: number }) {
  const W = 200;
  const H = height;
  const PAD = 3;
  const step = W / (BUFFER_SIZE - 1);
  if (data.length < 2) {
    return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} />;
  }
  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const range = hi - lo || 1;
  const points = data
    .map((v, i) => {
      const x = W - (data.length - 1 - i) * step;
      const y = PAD + ((hi - v) / range) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: H, display: "block" }}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#4c9eed"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SparkRow({ label, data, value }: { label: string; data: number[]; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
      <span style={metricLabel}>{label}</span>
      <span style={valueStyle}>{value}</span>
      <div style={graphContainer}>
        <Sparkline data={data} />
      </div>
    </div>
  );
}

interface ProfileEditModalProps {
  closeModal?: () => void;
  profile: Profile | null;
  notches: number[];
  defaults: ConfigDefaults | null;
  onSave: (p: Profile) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

function ProfileEditModal({ closeModal, profile, notches, defaults, onSave, onDelete }: ProfileEditModalProps) {
  const fiftyMhzSteps = useMemo(() => {
    const lo = notches[0] ?? 0;
    const hi = notches[notches.length - 1] ?? 0;
    const steps: number[] = [];
    for (let f = lo; f <= hi; f += 50) steps.push(f);
    if (steps.length === 0 || steps[steps.length - 1] !== hi) steps.push(hi);
    return steps;
  }, [notches]);

  const snapIdx = (mhz: number, freqs: number[]) =>
    freqs.reduce((best, f, i) => Math.abs(f - mhz) < Math.abs(freqs[best] - mhz) ? i : best, 0);

  const findNotchIdx = (mhz: number | undefined, fallback: number) => {
    if (mhz == null) return Math.max(0, notches.indexOf(fallback));
    const idx = notches.indexOf(mhz);
    return idx >= 0 ? idx : notches.length - 1;
  };

  const [name, setName] = useState(profile?.name ?? "New Profile");
  const [useTomlSteps, setUseTomlSteps] = useState(true);
  const activeFreqs = useTomlSteps ? notches : fiftyMhzSteps;

  const [minFreqIdx, setMinFreqIdx] = useState(() =>
    findNotchIdx(profile?.min_freq_mhz, defaults?.min_freq_mhz ?? 0)
  );
  const [maxFreqIdx, setMaxFreqIdx] = useState(() =>
    findNotchIdx(profile?.max_freq_mhz, defaults?.max_freq_mhz ?? notches[notches.length - 1])
  );

  const handleToggleSteps = (toml: boolean) => {
    const currentMin = activeFreqs[minFreqIdx];
    const currentMax = activeFreqs[maxFreqIdx];
    const newFreqs = toml ? notches : fiftyMhzSteps;
    setUseTomlSteps(toml);
    setMinFreqIdx(snapIdx(currentMin, newFreqs));
    setMaxFreqIdx(snapIdx(currentMax, newFreqs));
  };
  const [loadMin, setLoadMin] = useState(
    Math.round((profile?.load_min ?? defaults?.load_min ?? 0.5) * 100)
  );
  const [loadMax, setLoadMax] = useState(
    Math.round((profile?.load_max ?? defaults?.load_max ?? 0.65) * 100)
  );
  const [throttleTemp, setThrottleTemp] = useState(
    profile?.temp_throttling ?? defaults?.temp_throttling ?? 85
  );
  const [recoveryTemp, setRecoveryTemp] = useState(
    profile?.temp_recovery ?? defaults?.temp_recovery ?? 75
  );

  const isValid =
    name.trim().length > 0 &&
    minFreqIdx <= maxFreqIdx &&
    loadMin <= loadMax &&
    recoveryTemp < throttleTemp;

  const handleMaxFreqIdx = (v: number) => {
    setMaxFreqIdx(v);
    if (minFreqIdx > v) setMinFreqIdx(v);
  };
  const handleMinFreqIdx = (v: number) => {
    setMinFreqIdx(v);
    if (maxFreqIdx < v) setMaxFreqIdx(v);
  };
  const handleLoadMax = (v: number) => {
    setLoadMax(v);
    if (loadMin > v) setLoadMin(v);
  };
  const handleLoadMin = (v: number) => {
    setLoadMin(v);
    if (loadMax < v) setLoadMax(v);
  };
  const handleThrottleTemp = (v: number) => {
    setThrottleTemp(v);
    if (recoveryTemp >= v) setRecoveryTemp(v - 1);
  };
  const handleRecoveryTemp = (v: number) => {
    setRecoveryTemp(v);
    if (throttleTemp <= v) setThrottleTemp(v + 1);
  };

  const handleSave = async () => {
    const p: Profile = {
      id: profile?.id ?? "",
      name: name.trim(),
      min_freq_mhz: activeFreqs[minFreqIdx],
      max_freq_mhz: activeFreqs[maxFreqIdx],
      load_min: loadMin / 100,
      load_max: loadMax / 100,
      temp_throttling: throttleTemp,
      temp_recovery: recoveryTemp,
      use_toml_steps: useTomlSteps,
    };
    await onSave(p);
    closeModal?.();
  };

  const minFreqLabel = activeFreqs[minFreqIdx] === 0 ? "Adaptive" : `${activeFreqs[minFreqIdx]} MHz`;

  return (
    <ModalRoot bAllowFullSize onCancel={closeModal}>
      <DialogHeader>{profile ? "Edit Profile" : "New Profile"}</DialogHeader>
      <DialogBody>
        <DialogControlsSection>
          <DialogControlsSectionHeader>Name</DialogControlsSectionHeader>
          <TextField
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </DialogControlsSection>

        <DialogControlsSection>
          <DialogControlsSectionHeader>Frequency</DialogControlsSectionHeader>
          <ToggleField
            label="Use TOML safe-point steps"
            checked={useTomlSteps}
            onChange={handleToggleSteps}
          />
          <SliderField
            label={`Min: ${minFreqLabel}`}
            value={minFreqIdx}
            min={0}
            max={activeFreqs.length - 1}
            step={1}
            onChange={handleMinFreqIdx}
          />
          <SliderField
            label={`Max: ${activeFreqs[maxFreqIdx]} MHz`}
            value={maxFreqIdx}
            min={0}
            max={activeFreqs.length - 1}
            step={1}
            onChange={handleMaxFreqIdx}
          />
        </DialogControlsSection>

        <DialogControlsSection>
          <DialogControlsSectionHeader>Load Target</DialogControlsSectionHeader>
          <SliderField
            label={`Min: ${loadMin}%`}
            value={loadMin}
            min={0}
            max={100}
            step={10}
            onChange={handleLoadMin}
          />
          <SliderField
            label={`Max: ${loadMax}%`}
            value={loadMax}
            min={0}
            max={100}
            step={10}
            onChange={handleLoadMax}
          />
        </DialogControlsSection>

        <DialogControlsSection>
          <DialogControlsSectionHeader>Temperature</DialogControlsSectionHeader>
          <SliderField
            label={`Throttle: ${throttleTemp}°C`}
            value={throttleTemp}
            min={30}
            max={110}
            step={5}
            onChange={handleThrottleTemp}
          />
          <SliderField
            label={`Recovery: ${recoveryTemp}°C`}
            value={recoveryTemp}
            min={30}
            max={110}
            step={5}
            onChange={handleRecoveryTemp}
          />
        </DialogControlsSection>

        {!isValid && name.trim().length > 0 && (
          <div style={{ color: "var(--field-negative-color, #e05c5c)", fontSize: "0.8em", marginTop: "8px" }}>
            {minFreqIdx > maxFreqIdx && "Min freq must be ≤ max freq. "}
            {loadMin > loadMax && "Load min must be ≤ load max. "}
            {recoveryTemp >= throttleTemp && "Recovery temp must be < throttle temp."}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <DialogButtonPrimary disabled={!isValid} onClick={handleSave}>
            <FaSave style={{ verticalAlign: "middle", marginRight: "6px" }} /> Save
          </DialogButtonPrimary>
          <DialogButton onClick={closeModal}>Cancel</DialogButton>
        </div>
        {profile && onDelete && (
          <DialogButtonSecondary
            style={{ color: "var(--field-negative-color, #e05c5c)", width: "100%", marginTop: "8px" }}
            onClick={() => {
              showModal(
                <ConfirmModal
                  strTitle="Delete Profile"
                  strDescription={`Delete "${profile.name}"? This cannot be undone.`}
                  onOK={async () => {
                    await onDelete(profile.id);
                    closeModal?.();
                  }}
                  strOKButtonText="Delete"
                  bDestructiveWarning
                />
              );
            }}
          >
            <FaTrash style={{ verticalAlign: "middle", marginRight: "6px" }} /> Delete Profile
          </DialogButtonSecondary>
        )}
      </DialogFooter>
    </ModalRoot>
  );
}

function snapToEffective(freq: number, effective: number[]): number {
  if (!effective.length) return 0;
  return effective.reduce((best, f, i) =>
    Math.abs(f - freq) < Math.abs(effective[best] - freq) ? i : best, 0);
}

function computeEffectiveNotches(profile: Profile | null, allNotches: number[]): number[] {
  if (!profile) return allNotches;
  const { min_freq_mhz, max_freq_mhz, use_toml_steps } = profile;
  if (use_toml_steps !== false) {
    return allNotches.filter((f) => f >= min_freq_mhz && f <= max_freq_mhz);
  }
  const steps: number[] = [];
  for (let f = min_freq_mhz; f <= max_freq_mhz; f += 50) steps.push(f);
  if (!steps.length || steps[steps.length - 1] !== max_freq_mhz) steps.push(max_freq_mhz);
  return steps;
}

function Content() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [index, setIndex] = useState(0);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [debug, setDebug] = useState<Record<string, string | number | null> | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(
    () => (localStorage.getItem("bc250_display_mode") as DisplayMode | null) ?? "minimal",
  );
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<{ version: string | null; status: GovernorStatus; min_version: string; config_path: string } | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [profilesCorrupt, setProfilesCorrupt] = useState(false);
  const [resettingProfiles, setResettingProfiles] = useState(false);

  const updateAvailable = latestVersion !== null && latestVersion !== `v${__PLUGIN_VERSION__}`;

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      const result = await updatePlugin();
      if (result.started) {
        toaster.toast({ title: "BC250 Profiles", body: "Updating — the Quick Access menu will reload shortly." });
      } else {
        toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to start update" });
        setUpdating(false);
      }
    } catch (e) {
      console.error("[bc250] update_plugin threw:", e);
      toaster.toast({ title: "BC250 Profiles", body: "Failed to start update" });
      setUpdating(false);
    }
  };

  const appliedIndexRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const telemetryRef = useRef<Telemetry | null>(null);
  const bufferRef = useRef<Record<TelemetryKey, number[]>>({
    gfx_clock_mhz: [],
    gpu_temp_c: [],
    cpu_clock_mhz: [],
    cpu_temp_c: [],
    gpu_power_w: [],
    gpu_load_pct: [],
    cpu_usage_pct: [],
  });

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId]
  );
  const effectiveNotches = useMemo(
    () => (status ? computeEffectiveNotches(activeProfile, status.notches) : []),
    [status, activeProfile]
  );

  const pushToBuffer = (t: Telemetry) => {
    const b = bufferRef.current;
    (Object.keys(b) as TelemetryKey[]).forEach((key) => {
      const val = t[key];
      if (val != null) {
        b[key].push(val);
        if (b[key].length > BUFFER_SIZE) b[key].shift();
      }
    });
  };

  const padBuffer = (t: Telemetry) => {
    const b = bufferRef.current;
    (Object.keys(b) as TelemetryKey[]).forEach((key) => {
      const val = t[key];
      if (val == null) return;
      if (b[key].length === 0) {
        b[key] = Array(BUFFER_SIZE).fill(val);
      } else if (b[key].length < BUFFER_SIZE) {
        const padVal = b[key][0];
        b[key] = [...Array(BUFFER_SIZE - b[key].length).fill(padVal), ...b[key]];
      }
    });
  };

  const pushTelemetry = (t: Telemetry) => {
    telemetryRef.current = t;
    if (displayModeRef.current === "histogram") pushToBuffer(t);
    setTelemetry(t);
  };

  const clearBuffer = () => {
    const b = bufferRef.current;
    (Object.keys(b) as TelemetryKey[]).forEach((key) => { b[key] = []; });
  };

  const handleDisplayMode = async (mode: DisplayMode) => {
    const wasHistogram = displayModeRef.current === "histogram";
    const isHistogram = mode === "histogram";
    setDisplayMode(mode);
    localStorage.setItem("bc250_display_mode", mode);
    if (isHistogram && !wasHistogram) {
      await setHistoryEnabled(true);
      const history = await getHistory();
      history.forEach(pushToBuffer);
      if (telemetryRef.current) padBuffer(telemetryRef.current);
    } else if (!isHistogram && wasHistogram) {
      clearBuffer();
      await setHistoryEnabled(false);
    }
  };

  const refreshProfiles = async () => {
    const data = await listProfiles();
    setProfiles(data.profiles);
    setActiveProfileId(data.active_id);
  };

  const openEditModal = (profile: Profile | null, notches: number[], defaults: ConfigDefaults | null) => {
    showModal(
      <ProfileEditModal
        profile={profile}
        notches={notches}
        defaults={defaults}
        onSave={async (p) => {
          const result = await saveProfile(p);
          if (!result.ok) {
            toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to save profile" });
            return;
          }
          await refreshProfiles();
          if (!p.id && result.id) {
            // new profile — make it active and apply it
            await setActiveProfile(result.id);
            await refreshProfiles();
          }
        }}
        onDelete={async (id) => {
          const result = await deleteProfile(id);
          if (!result.ok) {
            toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to delete profile" });
            return;
          }
          await refreshProfiles();
        }}
      />
    );
  };

  useEffect(() => {
    fetchNoCors("https://api.github.com/repos/mix3d/bc250-perf-profile-switcher/releases/latest")
      .then((r) => r.json())
      .then((data) => { if (data?.tag_name) setLatestVersion(data.tag_name); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [verInfo, s, profilesData] = await Promise.all([
        getGovernorVersion(),
        getStatus(),
        listProfiles(),
      ]);
      if (cancelled) return;

      setVersionInfo(verInfo);

      // "unknown" means the service isn't running — defer to getStatus() for the right error.
      // Any other non-"compatible" status is a real version gate, so stop loading and show it.
      if (verInfo.status !== "compatible" && verInfo.status !== "unknown") {
        setLoading(false);
        return;
      }

      // profiles.json couldn't be parsed — don't touch it until the user
      // explicitly chooses to reset it, so any recoverable data stays intact.
      if (profilesData.corrupt) {
        setProfilesCorrupt(true);
        setLoading(false);
        return;
      }

      setStatus(s);
      const initProfile = profilesData.profiles.find((p: Profile) => p.id === profilesData.active_id) ?? null;
      const initEffective = computeEffectiveNotches(initProfile, s.notches);
      const initIdx = snapToEffective(s.current_freq_mhz, initEffective);
      setIndex(initIdx);
      appliedIndexRef.current = initIdx;
      setProfiles(profilesData.profiles);
      setActiveProfileId(profilesData.active_id);
      setLoading(false);

      if (!s.available) {
        const d = await getDebugInfo();
        if (!cancelled) setDebug(d);
        return;
      }

      if (displayModeRef.current === "histogram") {
        await setHistoryEnabled(true);
        const history = await getHistory();
        if (!cancelled) history.forEach(pushToBuffer);
      }

      const t = await getTelemetry();
      if (!cancelled) {
        pushTelemetry(t);
        if (displayModeRef.current === "histogram") padBuffer(t);
      }

      if (!cancelled) {
        pollRef.current = setInterval(async () => {
          const t = await getTelemetry();
          pushTelemetry(t);
        }, 1000);
      }
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  const handleChange = (newIndex: number) => {
    setIndex(newIndex);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!status) return;
      const freq = effectiveNotches[newIndex];
      const result = await applyCap(freq);
      if (!result.ok) {
        toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to apply cap" });
        setIndex(appliedIndexRef.current);
      } else {
        appliedIndexRef.current = newIndex;
        // Update cap_freq_mhz locally; max_freq_mhz never changes on a cap, and a
        // full listProfiles() refetch was causing effectiveNotches to recompute incorrectly.
        setProfiles((prev) =>
          prev.map((p) =>
            p.id === activeProfileId
              ? { ...p, cap_freq_mhz: effectiveNotches[newIndex] }
              : p
          )
        );
      }
    }, 300);
  };

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <Spinner />
        </PanelSectionRow>
      </PanelSection>
    );
  }

  // Version gate — blocks all UI unless the governor is installed and compatible
  if (versionInfo && versionInfo.status !== "compatible" && versionInfo.status !== "unknown") {
    const msg = versionInfo.status === "not_installed"
      ? "cyan-skillfish-governor-smu not found — install the governor to use this plugin."
      : versionInfo.status === "stale_service"
      ? `Governor v${versionInfo.version} is installed but the running service is still on an older version — restart cyan-skillfish-governor-smu to apply it.`
      : versionInfo.status === "dbus_disabled"
      ? "Governor D-Bus interface is disabled. Set dbus.enabled = true in the governor config and restart cyan-skillfish-governor-smu."
      : versionInfo.status === "config_unreadable"
      ? `Could not read the governor config at ${versionInfo.config_path} — check that it exists and is readable. Nothing in this plugin can work reliably until that's fixed.`
      : `Governor v${versionInfo.version} is too old — v${versionInfo.min_version}+ required. Please update cyan-skillfish-governor-smu.`;
    return (
      <PanelSection title="Governor Required">
        <PanelSectionRow>
          <div style={{ color: "var(--field-negative-color, #e05c5c)" }}>{msg}</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  // Profiles gate — profiles.json exists but couldn't be parsed. Don't touch
  // it (save/delete/etc. would silently overwrite whatever's recoverable)
  // until the user explicitly confirms they want to discard it.
  if (profilesCorrupt) {
    return (
      <PanelSection title="Profiles File Corrupted">
        <PanelSectionRow>
          <div style={{ color: "var(--field-negative-color, #e05c5c)" }}>
            Your saved profiles file could not be read and may be corrupted. Resetting will discard any
            existing profiles. Leaving it as-is stops the plugin here so nothing gets overwritten.
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <DialogButton
            disabled={resettingProfiles}
            onClick={async () => {
              setResettingProfiles(true);
              const result = await resetProfiles();
              setResettingProfiles(false);
              if (!result.ok) {
                toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to reset profiles" });
                return;
              }
              setProfilesCorrupt(false);
              await refreshProfiles();
            }}
          >
            {resettingProfiles ? "Resetting…" : "Reset Profiles (discard corrupted data)"}
          </DialogButton>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!status?.available) {
    return (
      <>
        <PanelSection title="GPU Max Clock">
          <PanelSectionRow>
            <div style={{ color: "var(--field-negative-color, #e05c5c)" }}>
              {status?.reason ?? "Governor unavailable"}
            </div>
          </PanelSectionRow>
        </PanelSection>
        {debug && (
          <PanelSection title="Debug">
            <PanelSectionRow>
              <div style={{ fontSize: "0.75em", wordBreak: "break-all", opacity: 0.55 }}>
                {Object.entries(debug).map(([k, v]) => (
                  <div key={k}>
                    <b>{k}:</b> {String(v ?? "null")}
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          </PanelSection>
        )}
      </>
    );
  }

  const currentMhz = effectiveNotches[index] ?? 0;
  const buf = bufferRef.current;

  const hasGpu = telemetry != null && (
    telemetry.gfx_clock_mhz != null || telemetry.gpu_temp_c != null || telemetry.gpu_load_pct != null
  );
  const hasCpu = telemetry != null && (
    telemetry.cpu_clock_mhz != null || telemetry.cpu_temp_c != null || telemetry.cpu_usage_pct != null
  );

  return (
    <>
      {updateAvailable && (
        <div style={{
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.15)",
          fontSize: "0.9em",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          color: "rgba(255,255,255,0.85)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <FaExclamationTriangle style={{ color: "#f5a623", flexShrink: 0 }} />
            Update available: {latestVersion}
          </div>
          <DialogButton disabled={updating} onClick={handleUpdate}>
            {updating ? "Updating…" : "Update now"}
          </DialogButton>
        </div>
      )}
      <PanelSection title="Profile">
        <PanelSectionRow>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
            <div style={{ flex: 1 }}>
              <DropdownItem
                label="Active"
                rgOptions={[
                  ...profiles.map((p) => ({ data: p.id, label: p.name })),
                  { data: "__new__", label: "+ New profile…" },
                ]}
                selectedOption={activeProfileId ?? ""}
                onChange={async (e) => {
                  if (e.data === "__new__") {
                    const defaults = await getConfigDefaults();
                    openEditModal(null, status.notches, defaults);
                    return;
                  }
                  const result = await setActiveProfile(e.data);
                  if (!result.ok) {
                    toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to switch profile" });
                    return;
                  }
                  const switched = profiles.find((p) => p.id === e.data);
                  if (switched) {
                    const newEffective = computeEffectiveNotches(switched, status.notches);
                    const targetFreq = switched.cap_freq_mhz ?? switched.max_freq_mhz;
                    const newIdx = snapToEffective(targetFreq, newEffective);
                    setIndex(newIdx);
                    appliedIndexRef.current = newIdx;
                  }
                  setActiveProfileId(e.data);
                }}
              />
            </div>
            {activeProfile && (
              <DialogButton
                style={{ minWidth: 0, width: "36px", padding: "8px", flexShrink: 0 }}
                onClick={async () => {
                  const defaults = await getConfigDefaults();
                  openEditModal(activeProfile, status.notches, defaults);
                }}
              >
                <FaPencilAlt />
              </DialogButton>
            )}
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="GPU Max Clock">
        <PanelSectionRow>
          <SliderField
            label={`${currentMhz} MHz`}
            value={index}
            min={0}
            max={effectiveNotches.length - 1}
            step={1}
            notchCount={activeProfile?.use_toml_steps !== false ? effectiveNotches.length : undefined}
            onChange={handleChange}
          />
        </PanelSectionRow>
      </PanelSection>

      {(hasGpu || hasCpu) && (
        <PanelSection title="Status">
          {displayMode === "minimal" && telemetry && (
            <PanelSectionRow>
              <div style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr 1fr",
                rowGap: "5px",
                columnGap: "10px",
                alignItems: "center",
              }}>
                <div />
                <div style={{ ...dimLabel, textAlign: "right" }}>MHz</div>
                <div style={{ ...dimLabel, textAlign: "right" }}>Temp</div>
                <div style={{ ...dimLabel, textAlign: "right" }}>Load</div>
                {hasGpu && <>
                  <div style={rowHead}>GPU</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.gfx_clock_mhz ?? "—"}</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.gpu_temp_c != null ? `${telemetry.gpu_temp_c.toFixed(0)}°` : "—"}</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.gpu_load_pct != null ? `${telemetry.gpu_load_pct}%` : "—"}</div>
                </>}
                {hasCpu && <>
                  <div style={rowHead}>CPU</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.cpu_clock_mhz ?? "—"}</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.cpu_temp_c != null ? `${telemetry.cpu_temp_c.toFixed(0)}°` : "—"}</div>
                  <div style={{ ...cellValue, textAlign: "right" }}>{telemetry.cpu_usage_pct != null ? `${telemetry.cpu_usage_pct}%` : "—"}</div>
                </>}
              </div>
            </PanelSectionRow>
          )}

          {displayMode === "histogram" && telemetry && (
            <PanelSectionRow>
              <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
                {hasGpu && (
                  <>
                    <div style={sectionHead("2px")}>GPU</div>
                    {telemetry.gfx_clock_mhz != null && (
                      <SparkRow label="Clock" data={buf.gfx_clock_mhz} value={`${telemetry.gfx_clock_mhz} MHz`} />
                    )}
                    {telemetry.gpu_temp_c != null && (
                      <SparkRow label="Temp" data={buf.gpu_temp_c} value={`${telemetry.gpu_temp_c.toFixed(0)}°C`} />
                    )}
                    {telemetry.gpu_load_pct != null && (
                      <SparkRow label="Load" data={buf.gpu_load_pct} value={`${telemetry.gpu_load_pct}%`} />
                    )}
                  </>
                )}
                {hasCpu && (
                  <>
                    <div style={sectionHead(hasGpu ? "10px" : "2px")}>CPU</div>
                    {telemetry.cpu_clock_mhz != null && (
                      <SparkRow label="Clock" data={buf.cpu_clock_mhz} value={`${telemetry.cpu_clock_mhz} MHz`} />
                    )}
                    {telemetry.cpu_temp_c != null && (
                      <SparkRow label="Temp" data={buf.cpu_temp_c} value={`${telemetry.cpu_temp_c.toFixed(0)}°C`} />
                    )}
                    {telemetry.cpu_usage_pct != null && (
                      <SparkRow label="Usage" data={buf.cpu_usage_pct} value={`${telemetry.cpu_usage_pct}%`} />
                    )}
                  </>
                )}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <DropdownItem
              label="Display"
              rgOptions={[
                { data: "off", label: "Off" },
                { data: "minimal", label: "Minimal" },
                { data: "histogram", label: "Histogram" },
              ]}
              selectedOption={displayMode}
              onChange={(e) => { handleDisplayMode(e.data as DisplayMode); }}
            />
          </PanelSectionRow>
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  return {
    name: "BC-250 Perf",
    titleView: <div className={staticClasses.Title}>BC-250 Perf</div>,
    content: <Content />,
    icon: <FaBolt />,
    onDismount() {},
  };
});
