import asyncio
import collections
import json
import os
import shutil
import tomllib

import decky

GOVERNOR_CONFIG = "/etc/cyan-skillfish-governor-smu/config.toml"
GOVERNOR_SERVICE = "com.cyan.SkillFishGovernor"
GOVERNOR_OBJECT = "/com/cyan/SkillFishGovernor"
GOVERNOR_IFACE = "com.cyan.SkillFishGovernor.PerformanceMode"

# Decky Loader is a PyInstaller bundle that sets LD_LIBRARY_PATH to its temp
# dir, which shadows system libraries. Strip it before spawning subprocesses so
# busctl picks up the correct system libcrypto/libsystemd.
_CLEAN_ENV = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}


def _check_system_deps() -> str | None:
    """Return an actionable error string if a hard dependency is missing, else None."""
    if shutil.which("busctl") is None:
        return (
            "busctl not found on PATH. "
            "This plugin requires a systemd/D-Bus system (SteamOS or Arch-based)."
        )
    return None


def _derive_notches() -> list:
    with open(GOVERNOR_CONFIG, "rb") as f:
        config = tomllib.load(f)

    safe_points = sorted(sp["frequency"] for sp in config.get("safe-points", []))

    freq_range = config.get("frequency-range") or config.get("frequency_range") or {}
    eff_min = freq_range.get("min", safe_points[0] if safe_points else 0)
    eff_max = freq_range.get("max", safe_points[-1] if safe_points else 0)

    return sorted(set(
        [eff_min, eff_max] + [f for f in safe_points if eff_min <= f <= eff_max]
    ))


def _get_unavailable_reason() -> str:
    """Diagnose why the governor D-Bus service is not available."""
    try:
        with open(GOVERNOR_CONFIG, "rb") as f:
            config = tomllib.load(f)
        if not config.get("dbus", {}).get("enabled", True):
            return (
                "Governor D-Bus interface is disabled. "
                "Set dbus.enabled = true in the governor config and restart the service."
            )
        return "Governor is installed but not running."
    except FileNotFoundError:
        return f"Governor not installed (config not found at {GOVERNOR_CONFIG})."
    except Exception as e:
        return f"Governor unavailable: {e}"


async def _is_governor_available() -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            "busctl", "--system", "status", GOVERNOR_SERVICE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=_CLEAN_ENV,
        )
        await proc.wait()
        return proc.returncode == 0
    except Exception:
        return False


async def _get_debug_info() -> dict:
    info: dict = {}
    info["busctl_path"] = shutil.which("busctl")
    try:
        proc = await asyncio.create_subprocess_exec(
            "busctl", "--system", "status", GOVERNOR_SERVICE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_CLEAN_ENV,
        )
        stdout, stderr = await proc.communicate()
        info["busctl_exit"] = proc.returncode
        info["busctl_stdout"] = stdout.decode(errors="replace").strip()[:300]
        info["busctl_stderr"] = stderr.decode(errors="replace").strip()[:300]
    except Exception as e:
        info["busctl_exception"] = str(e)
    try:
        with open(GOVERNOR_CONFIG, "rb") as f:
            tomllib.load(f)
        info["config"] = "ok"
    except FileNotFoundError:
        info["config"] = "not found"
    except Exception as e:
        info["config"] = f"error: {e}"
    return info


def _load_persisted() -> int | None:
    try:
        path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "state.json")
        with open(path) as f:
            return json.load(f).get("last_cap_mhz")
    except Exception:
        return None


def _save_persisted(freq_mhz: int) -> None:
    path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "state.json")
    with open(path, "w") as f:
        json.dump({"last_cap_mhz": freq_mhz}, f)




class Plugin:
    async def get_status(self) -> dict:
        try:
            dep_error = _check_system_deps()
            if dep_error:
                return {"available": False, "reason": dep_error, "notches": [], "current_index": 0}

            available = await _is_governor_available()
            if not available:
                return {
                    "available": False,
                    "reason": _get_unavailable_reason(),
                    "notches": [],
                    "current_index": 0,
                }

            # Refresh the notch cache on panel open — right time to pick up any
            # config edits the user made in desktop mode before this session.
            notches = _derive_notches()
            self._notches = notches

            if not notches:
                return {
                    "available": False,
                    "reason": "No valid notches could be derived from the governor config.",
                    "notches": [],
                    "current_index": 0,
                }

            persisted = _load_persisted()
            if persisted is not None and persisted in notches:
                current_index = notches.index(persisted)
            else:
                current_index = len(notches) - 1

            return {
                "available": True,
                "reason": None,
                "notches": notches,
                "current_index": current_index,
            }
        except Exception as e:
            decky.logger.error(f"get_status error: {e}")
            return {
                "available": False,
                "reason": f"Error reading governor status: {e}",
                "notches": [],
                "current_index": 0,
            }

    async def get_debug_info(self) -> dict:
        return await _get_debug_info()

    async def apply_cap(self, freq_mhz: int) -> dict:
        try:
            notches = self._notches
            if not notches:
                return {"ok": False, "error": "Notch list not loaded; open the plugin panel first."}
            if freq_mhz not in notches:
                decky.logger.error(f"apply_cap: invalid frequency {freq_mhz}, valid: {notches}")
                return {"ok": False, "error": "Invalid frequency"}

            proc = await asyncio.create_subprocess_exec(
                "busctl", "--system", "call",
                GOVERNOR_SERVICE,
                GOVERNOR_OBJECT,
                GOVERNOR_IFACE,
                "SetRange",
                "uu", "0", str(freq_mhz),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_CLEAN_ENV,
            )
            _, stderr_bytes = await proc.communicate()

            if proc.returncode == 0:
                _save_persisted(freq_mhz)
                decky.logger.info(f"apply_cap: set max clock to {freq_mhz} MHz")
                return {"ok": True, "error": None}
            else:
                stderr = stderr_bytes.decode(errors="replace").strip()
                decky.logger.error(f"apply_cap: busctl failed (exit {proc.returncode}): {stderr}")
                return {"ok": False, "error": stderr or f"busctl exited with code {proc.returncode}"}
        except Exception as e:
            decky.logger.error(f"apply_cap error: {e}")
            return {"ok": False, "error": str(e)}

    async def get_telemetry(self) -> dict:
        gpu_temp_c = None
        cpu_temp_c = None
        gfx_clock_mhz = None
        cpu_clock_mhz = None
        gpu_power_w = None
        cpu_usage_pct = None

        try:
            hwmon_base = "/sys/class/hwmon"
            if os.path.isdir(hwmon_base):
                for entry in os.listdir(hwmon_base):
                    hwmon_path = os.path.join(hwmon_base, entry)
                    try:
                        with open(os.path.join(hwmon_path, "name")) as f:
                            driver_name = f.read().strip()
                    except Exception:
                        continue

                    if driver_name == "amdgpu" and gpu_temp_c is None:
                        try:
                            with open(os.path.join(hwmon_path, "temp1_input")) as f:
                                gpu_temp_c = int(f.read().strip()) / 1000.0
                        except Exception:
                            pass
                        try:
                            with open(os.path.join(hwmon_path, "freq1_input")) as f:
                                gfx_clock_mhz = int(f.read().strip()) // 1_000_000
                        except Exception:
                            pass
                        try:
                            with open(os.path.join(hwmon_path, "power1_average")) as f:
                                gpu_power_w = int(f.read().strip()) / 1_000_000
                        except Exception:
                            pass

                    if driver_name == "k10temp" and cpu_temp_c is None:
                        try:
                            with open(os.path.join(hwmon_path, "temp1_input")) as f:
                                cpu_temp_c = int(f.read().strip()) / 1000.0
                        except Exception:
                            pass
        except Exception as e:
            decky.logger.error(f"get_telemetry error: {e}")

        try:
            cpu_base = "/sys/devices/system/cpu"
            freqs = []
            if os.path.isdir(cpu_base):
                for cpu in os.listdir(cpu_base):
                    for fname in ("scaling_cur_freq", "cpuinfo_cur_freq"):
                        freq_file = os.path.join(cpu_base, cpu, "cpufreq", fname)
                        try:
                            with open(freq_file) as f:
                                freqs.append(int(f.read().strip()))
                            break
                        except Exception:
                            pass
            if freqs:
                cpu_clock_mhz = max(freqs) // 1000
            else:
                with open("/proc/cpuinfo") as f:
                    mhz_vals = [
                        float(line.split(":", 1)[1].strip())
                        for line in f
                        if line.startswith("cpu MHz")
                    ]
                if mhz_vals:
                    cpu_clock_mhz = int(max(mhz_vals))
        except Exception as e:
            decky.logger.error(f"get_telemetry cpu_clock error: {e}")

        try:
            with open("/proc/stat") as f:
                line = f.readline()
            parts = line.split()
            vals = [int(x) for x in parts[1:8]]  # user nice system idle iowait irq softirq
            idle = vals[3] + vals[4]
            total = sum(vals)
            if hasattr(self, "_prev_cpu_stat"):
                prev_total, prev_idle = self._prev_cpu_stat
                d_total = total - prev_total
                d_idle = idle - prev_idle
                if d_total > 0:
                    cpu_usage_pct = int(round((1 - d_idle / d_total) * 100))
            self._prev_cpu_stat = (total, idle)
        except Exception as e:
            decky.logger.error(f"get_telemetry cpu_usage error: {e}")

        return {
            "gpu_temp_c": gpu_temp_c,
            "cpu_temp_c": cpu_temp_c,
            "gfx_clock_mhz": gfx_clock_mhz,
            "cpu_clock_mhz": cpu_clock_mhz,
            "gpu_power_w": gpu_power_w,
            "cpu_usage_pct": cpu_usage_pct,
        }

    async def get_history(self) -> list:
        return list(self._history)

    async def set_history_enabled(self, enabled: bool) -> None:
        if enabled:
            if not self._poll_task or self._poll_task.done():
                self._poll_task = asyncio.create_task(self._poll_telemetry())
                decky.logger.info("history polling started")
        else:
            if self._poll_task and not self._poll_task.done():
                self._poll_task.cancel()
                try:
                    await self._poll_task
                except asyncio.CancelledError:
                    pass
                decky.logger.info("history polling stopped")

    async def _poll_telemetry(self):
        while True:
            try:
                t = await self.get_telemetry()
                if any(v is not None for v in t.values()):
                    self._history.append(t)
            except Exception as e:
                decky.logger.error(f"_poll_telemetry error: {e}")
            await asyncio.sleep(1)

    async def _main(self):
        self._notches: list = []
        self._history: collections.deque = collections.deque(maxlen=150)

        dep_error = _check_system_deps()
        if dep_error:
            decky.logger.error(f"_main: dependency check failed: {dep_error}")
        else:
            try:
                self._notches = _derive_notches()
                decky.logger.info(f"_main: loaded {len(self._notches)} notches: {self._notches}")
            except FileNotFoundError:
                decky.logger.info(f"_main: governor config not found at {GOVERNOR_CONFIG}, skipping load")
            except Exception as e:
                decky.logger.error(f"_main: failed to load notches: {e}")

            try:
                available = await _is_governor_available()
                if not available:
                    decky.logger.info("_main: governor not available, skipping re-apply")
                elif not self._notches:
                    decky.logger.info("_main: no notches loaded, skipping re-apply")
                else:
                    persisted = _load_persisted()
                    if persisted is None:
                        decky.logger.info("_main: no persisted cap, using governor default")
                    elif persisted not in self._notches:
                        decky.logger.info(
                            f"_main: persisted freq {persisted} no longer a valid notch "
                            f"(valid: {self._notches}), skipping re-apply"
                        )
                    else:
                        proc = await asyncio.create_subprocess_exec(
                            "busctl", "--system", "call",
                            GOVERNOR_SERVICE,
                            GOVERNOR_OBJECT,
                            GOVERNOR_IFACE,
                            "SetRange",
                            "uu", "0", str(persisted),
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.PIPE,
                            env=_CLEAN_ENV,
                        )
                        _, stderr_bytes = await proc.communicate()
                        if proc.returncode == 0:
                            decky.logger.info(f"_main: re-applied persisted cap {persisted} MHz")
                        else:
                            stderr = stderr_bytes.decode(errors="replace").strip()
                            decky.logger.error(f"_main: failed to re-apply cap: {stderr}")
            except Exception as e:
                decky.logger.error(f"_main error: {e}")

        self._poll_task: asyncio.Task | None = None

    async def _unload(self):
        if hasattr(self, "_poll_task") and self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        decky.logger.info("BC250 Perf: unloading")

    async def _uninstall(self):
        decky.logger.info("BC250 Perf: uninstalling")

    async def _migration(self):
        pass
