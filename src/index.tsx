import {
  PanelSection,
  PanelSectionRow,
  SliderField,
  Spinner,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaBolt } from "react-icons/fa";

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
}

const getStatus = callable<[], Status>("get_status");
const applyCap = callable<[number], { ok: boolean; error: string | null }>("apply_cap");
const getTelemetry = callable<[], Telemetry>("get_telemetry");
const getDebugInfo = callable<[], Record<string, string | number | null>>("get_debug_info");

function Content() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [index, setIndex] = useState(0);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [debug, setDebug] = useState<Record<string, string | number | null> | null>(null);
  const appliedIndexRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

      const t = await getTelemetry();
      if (!cancelled) setTelemetry(t);

      if (!cancelled) {
        pollRef.current = setInterval(async () => {
          const t = await getTelemetry();
          setTelemetry(t);
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
                  <div key={k}><b>{k}:</b> {String(v ?? "null")}</div>
                ))}
              </div>
            </PanelSectionRow>
          </PanelSection>
        )}
      </>
    );
  }

  const currentMhz = status.notches[index] ?? 0;

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
            notchTicksVisible
            onChange={handleChange}
          />
        </PanelSectionRow>
      </PanelSection>
      {telemetry && (telemetry.gfx_clock_mhz != null || telemetry.gpu_temp_c != null || telemetry.cpu_temp_c != null || telemetry.cpu_clock_mhz != null) && (
        <PanelSection title="Status">
          <PanelSectionRow>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "10px" }}>
              {(telemetry.gfx_clock_mhz != null || telemetry.gpu_temp_c != null) && (
                <div>
                  <div style={{ fontSize: "0.75em", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.65, marginBottom: "3px" }}>GPU</div>
                  <div style={{ display: "flex", gap: "16px", fontSize: "0.9em" }}>
                    {telemetry.gfx_clock_mhz != null && <span>{telemetry.gfx_clock_mhz} MHz</span>}
                    {telemetry.gpu_temp_c != null && <span>{telemetry.gpu_temp_c.toFixed(0)}°C</span>}
                  </div>
                </div>
              )}
              {(telemetry.cpu_clock_mhz != null || telemetry.cpu_temp_c != null) && (
                <div>
                  <div style={{ fontSize: "0.75em", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.65, marginBottom: "3px" }}>CPU</div>
                  <div style={{ display: "flex", gap: "16px", fontSize: "0.9em" }}>
                    {telemetry.cpu_clock_mhz != null && <span>{telemetry.cpu_clock_mhz} MHz</span>}
                    {telemetry.cpu_temp_c != null && <span>{telemetry.cpu_temp_c.toFixed(0)}°C</span>}
                  </div>
                </div>
              )}
            </div>
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
