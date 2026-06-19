import {
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  Spinner,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaBolt } from "react-icons/fa";

type DisplayMode = "off" | "minimal" | "histogram";

interface Status {
  available: boolean;
  reason: string | null;
  notches: number[];
  current_index: number;
  cpu_max_mhz: number | null;
}

interface Telemetry {
  gpu_temp_c: number | null;
  cpu_temp_c: number | null;
  gfx_clock_mhz: number | null;
  cpu_clock_mhz: number | null;
  gpu_busy_pct: number | null;
  cpu_usage_pct: number | null;
}

type TelemetryKey = keyof Telemetry;

const BUFFER_SIZE = 150; // 5 min at 2s polling

const SPARK_HEIGHT = 40;

const getStatus = callable<[], Status>("get_status");
const applyCap = callable<[number], { ok: boolean; error: string | null }>("apply_cap");
const getTelemetry = callable<[], Telemetry>("get_telemetry");
const getHistory = callable<[], Telemetry[]>("get_history");
const setHistoryEnabled = callable<[boolean], void>("set_history_enabled");
const getDebugInfo = callable<[], Record<string, string | number | null>>("get_debug_info");

function Sparkline({ data, max, height = SPARK_HEIGHT }: { data: number[]; max: number; height?: number }) {
  const W = 200;
  const H = height;
  const step = W / (BUFFER_SIZE - 1);
  if (data.length < 2) {
    return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} />;
  }
  const points = data
    .map((v, i) => {
      const x = W - (data.length - 1 - i) * step;
      const y = H - Math.max(0, Math.min(1, v / max)) * (H - 1);
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

function SparkRow({ label, data, max, value }: { label: string; data: number[]; max: number; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
      <span style={{ fontSize: "0.72em", opacity: 0.65, width: "44px", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Sparkline data={data} max={max} />
      </div>
      <span style={{ fontSize: "0.8em", width: "72px", textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

const sectionHeader = (marginTop: string): React.CSSProperties => ({
  fontSize: "0.75em",
  fontWeight: "bold",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  opacity: 0.65,
  marginBottom: "6px",
  marginTop,
});

function Content() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [index, setIndex] = useState(0);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [debug, setDebug] = useState<Record<string, string | number | null> | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(
    () => (localStorage.getItem("bc250_display_mode") as DisplayMode | null) ?? "minimal",
  );
  const appliedIndexRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const bufferRef = useRef<Record<TelemetryKey, number[]>>({
    gfx_clock_mhz: [],
    gpu_temp_c: [],
    cpu_clock_mhz: [],
    cpu_temp_c: [],
    gpu_busy_pct: [],
    cpu_usage_pct: [],
  });

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

  const pushTelemetry = (t: Telemetry) => {
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
    } else if (!isHistogram && wasHistogram) {
      clearBuffer();
      await setHistoryEnabled(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const s = await getStatus();
      if (cancelled) return;

      setStatus(s);
      setIndex(s.current_index);
      appliedIndexRef.current = s.current_index;
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
      if (!cancelled) pushTelemetry(t);

      if (!cancelled) {
        pollRef.current = setInterval(async () => {
          const t = await getTelemetry();
          pushTelemetry(t);
        }, 2000);
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
      const freq = status.notches[newIndex];
      const result = await applyCap(freq);
      if (!result.ok) {
        toaster.toast({ title: "BC250 Profiles", body: result.error ?? "Failed to apply cap" });
        setIndex(appliedIndexRef.current);
      } else {
        appliedIndexRef.current = newIndex;
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
              <div style={{ fontSize: "0.75em", wordBreak: "break-all", opacity: 0.8 }}>
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

  const currentMhz = status.notches[index] ?? 0;
  const gpuMax = status.notches[status.notches.length - 1];
  const cpuMax = status.cpu_max_mhz ?? 3600;
  const buf = bufferRef.current;

  const hasGpu = telemetry != null && (
    telemetry.gfx_clock_mhz != null || telemetry.gpu_temp_c != null || telemetry.gpu_busy_pct != null
  );
  const hasCpu = telemetry != null && (
    telemetry.cpu_clock_mhz != null || telemetry.cpu_temp_c != null || telemetry.cpu_usage_pct != null
  );

  return (
    <>
      <PanelSection title="GPU Max Clock">
        <PanelSectionRow>
          <SliderField
            label={`${currentMhz} MHz`}
            value={index}
            min={0}
            max={status.notches.length - 1}
            step={1}
            notchCount={status.notches.length}
            onChange={handleChange}
          />
        </PanelSectionRow>
      </PanelSection>

      {(hasGpu || hasCpu) && (
        <PanelSection title="Status">
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

          {displayMode === "minimal" && telemetry && (
            <PanelSectionRow>
              <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "10px" }}>
                {hasGpu && (
                  <div>
                    <div style={sectionHeader("0")}>GPU</div>
                    <div style={{ display: "flex", gap: "16px", fontSize: "0.9em" }}>
                      {telemetry.gfx_clock_mhz != null && <span>{telemetry.gfx_clock_mhz} MHz</span>}
                      {telemetry.gpu_temp_c != null && <span>{telemetry.gpu_temp_c.toFixed(0)}°C</span>}
                      {telemetry.gpu_busy_pct != null && <span>{telemetry.gpu_busy_pct}%</span>}
                    </div>
                  </div>
                )}
                {hasCpu && (
                  <div>
                    <div style={sectionHeader("0")}>CPU</div>
                    <div style={{ display: "flex", gap: "16px", fontSize: "0.9em" }}>
                      {telemetry.cpu_clock_mhz != null && <span>{telemetry.cpu_clock_mhz} MHz</span>}
                      {telemetry.cpu_temp_c != null && <span>{telemetry.cpu_temp_c.toFixed(0)}°C</span>}
                      {telemetry.cpu_usage_pct != null && <span>{telemetry.cpu_usage_pct}%</span>}
                    </div>
                  </div>
                )}
              </div>
            </PanelSectionRow>
          )}

          {displayMode === "histogram" && telemetry && (
            <PanelSectionRow>
              <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
                {hasGpu && (
                  <>
                    <div style={sectionHeader("2px")}>GPU</div>
                    {telemetry.gfx_clock_mhz != null && (
                      <SparkRow label="Clock" data={buf.gfx_clock_mhz} max={gpuMax} value={`${telemetry.gfx_clock_mhz} MHz`} />
                    )}
                    {telemetry.gpu_temp_c != null && (
                      <SparkRow label="Temp" data={buf.gpu_temp_c} max={100} value={`${telemetry.gpu_temp_c.toFixed(0)}°C`} />
                    )}
                    {telemetry.gpu_busy_pct != null && (
                      <SparkRow label="Usage" data={buf.gpu_busy_pct} max={100} value={`${telemetry.gpu_busy_pct}%`} />
                    )}
                  </>
                )}
                {hasCpu && (
                  <>
                    <div style={sectionHeader(hasGpu ? "10px" : "2px")}>CPU</div>
                    {telemetry.cpu_clock_mhz != null && (
                      <SparkRow label="Clock" data={buf.cpu_clock_mhz} max={cpuMax} value={`${telemetry.cpu_clock_mhz} MHz`} />
                    )}
                    {telemetry.cpu_temp_c != null && (
                      <SparkRow label="Temp" data={buf.cpu_temp_c} max={100} value={`${telemetry.cpu_temp_c.toFixed(0)}°C`} />
                    )}
                    {telemetry.cpu_usage_pct != null && (
                      <SparkRow label="Usage" data={buf.cpu_usage_pct} max={100} value={`${telemetry.cpu_usage_pct}%`} />
                    )}
                  </>
                )}
              </div>
            </PanelSectionRow>
          )}
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
