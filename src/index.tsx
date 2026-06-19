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
}

interface Telemetry {
  gpu_temp_c: number | null;
  cpu_temp_c: number | null;
  gfx_clock_mhz: number | null;
  cpu_clock_mhz: number | null;
  gpu_power_w: number | null;
  cpu_usage_pct: number | null;
}

type TelemetryKey = keyof Telemetry;

const BUFFER_SIZE = 60; // 1 min at 1s polling

const SPARK_HEIGHT = 40;

const getStatus = callable<[], Status>("get_status");
const applyCap = callable<[number], { ok: boolean; error: string | null }>("apply_cap");
const getTelemetry = callable<[], Telemetry>("get_telemetry");
const getHistory = callable<[], Telemetry[]>("get_history");
const setHistoryEnabled = callable<[boolean], void>("set_history_enabled");
const getDebugInfo = callable<[], Record<string, string | number | null>>("get_debug_info");

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
  const telemetryRef = useRef<Telemetry | null>(null);
  const bufferRef = useRef<Record<TelemetryKey, number[]>>({
    gfx_clock_mhz: [],
    gpu_temp_c: [],
    cpu_clock_mhz: [],
    cpu_temp_c: [],
    gpu_power_w: [],
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

  // Pad the left (oldest) side of each buffer with a flat line so the graph
  // fills the full width when history is shorter than BUFFER_SIZE.
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

  const currentMhz = status.notches[index] ?? 0;
  const buf = bufferRef.current;

  const hasGpu = telemetry != null && (
    telemetry.gfx_clock_mhz != null || telemetry.gpu_temp_c != null || telemetry.gpu_power_w != null
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
          {displayMode === "minimal" && telemetry && (
            <PanelSectionRow>
              <div style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "30px 1fr 1fr 1fr",
                rowGap: "5px",
                columnGap: "4px",
                alignItems: "center",
              }}>
                <div />
                <div style={dimLabel}>MHz</div>
                <div style={dimLabel}>Temp</div>
                <div style={dimLabel}>Load</div>
                {hasGpu && <>
                  <div style={rowHead}>GPU</div>
                  <div style={cellValue}>{telemetry.gfx_clock_mhz ?? "—"}</div>
                  <div style={cellValue}>{telemetry.gpu_temp_c != null ? `${telemetry.gpu_temp_c.toFixed(0)}°` : "—"}</div>
                  <div style={cellValue}>{telemetry.gpu_power_w != null ? `${telemetry.gpu_power_w.toFixed(1)}W` : "—"}</div>
                </>}
                {hasCpu && <>
                  <div style={rowHead}>CPU</div>
                  <div style={cellValue}>{telemetry.cpu_clock_mhz ?? "—"}</div>
                  <div style={cellValue}>{telemetry.cpu_temp_c != null ? `${telemetry.cpu_temp_c.toFixed(0)}°` : "—"}</div>
                  <div style={cellValue}>{telemetry.cpu_usage_pct != null ? `${telemetry.cpu_usage_pct}%` : "—"}</div>
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
                    {telemetry.gpu_power_w != null && (
                      <SparkRow label="Power" data={buf.gpu_power_w} value={`${telemetry.gpu_power_w.toFixed(1)} W`} />
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
