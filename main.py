import asyncio
import collections
import glob
import json
import os
import shutil
import struct
import time
import tomllib

import decky

GOVERNOR_CONFIG = "/etc/cyan-skillfish-governor-smu/config.toml"
GOVERNOR_SERVICE = "com.cyanskillfish.Governor"
GOVERNOR_OBJECT = "/com/cyanskillfish/Governor"
GOVERNOR_IFACE = "com.cyanskillfish.Governor.PerformanceMode"

# Decky Loader is a PyInstaller bundle that sets LD_LIBRARY_PATH to its temp
# dir, which shadows system libraries. Strip it before spawning subprocesses so
# busctl picks up the correct system libcrypto/libsystemd.
_CLEAN_ENV = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}

_PROFILES_PATH = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "profiles.json")


def _check_system_deps() -> str | None:
    """Return an actionable error string if a hard dependency is missing, else None."""
    if shutil.which("busctl") is None:
        return (
            "busctl not found on PATH. "
            "This plugin requires a systemd/D-Bus system (SteamOS or Arch-based)."
        )
    return None


def _version_gte(version_str: str, min_tuple: tuple) -> bool:
    try:
        parts = tuple(int(x) for x in version_str.strip().split(".")[:3])
        return parts >= min_tuple
    except Exception:
        return False


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


def _load_profiles() -> dict:
    try:
        with open(_PROFILES_PATH) as f:
            return json.load(f)
    except Exception:
        return {"profiles": [], "active_id": None}


def _save_profiles(data: dict) -> None:
    with open(_PROFILES_PATH, "w") as f:
        json.dump(data, f)


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

            notches = _derive_notches()
            self._notches = notches

            if not notches:
                return {
                    "available": False,
                    "reason": "No valid notches could be derived from the governor config.",
                    "notches": [],
                    "current_index": 0,
                }

            profiles_data = _load_profiles()
            active_id = profiles_data.get("active_id")
            current_freq_mhz = notches[-1]
            if active_id:
                active = next(
                    (p for p in profiles_data.get("profiles", []) if p["id"] == active_id), None
                )
                if active:
                    current_freq_mhz = active.get("cap_freq_mhz") or active.get("max_freq_mhz") or notches[-1]

            return {
                "available": True,
                "reason": None,
                "notches": notches,
                "current_freq_mhz": current_freq_mhz,
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

    async def get_governor_version(self) -> dict:
        bin_path = shutil.which("cyan-skillfish-governor-smu")
        if not bin_path:
            return {"version": None, "compatible": False}

        # Get display version; strip leading 'v' (e.g. "v0.4.6" → "0.4.6")
        version = None
        try:
            proc = await asyncio.create_subprocess_exec(
                bin_path, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_CLEAN_ENV,
            )
            stdout, _ = await proc.communicate()
            text = stdout.decode(errors="replace").strip()
            # expected: "cyan-skillfish-governor-smu v0.4.6"
            parts = text.split()
            raw = parts[-1] if parts else None
            version = raw.lstrip("v") if raw else None
        except Exception as e:
            decky.logger.error(f"get_governor_version binary check error: {e}")

        # Check compatibility by introspecting for SetParameters on the live service.
        # Returns None when the service isn't running so the frontend can defer to
        # get_status() rather than showing a false version error.
        compatible = None
        try:
            proc = await asyncio.create_subprocess_exec(
                "busctl", "--system", "introspect",
                GOVERNOR_SERVICE, GOVERNOR_OBJECT, GOVERNOR_IFACE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=_CLEAN_ENV,
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0:
                compatible = b"SetParameters" in stdout
            # non-zero → service not running; leave compatible=None
        except Exception as e:
            decky.logger.error(f"get_governor_version introspect error: {e}")

        return {"version": version, "compatible": compatible}

    async def get_config_defaults(self) -> dict:
        try:
            with open(GOVERNOR_CONFIG, "rb") as f:
                config = tomllib.load(f)
            notches = self._notches if hasattr(self, "_notches") and self._notches else _derive_notches()
            freq_range = config.get("frequency-range") or {}
            load_target = config.get("load-target") or {}
            temperature = config.get("temperature") or {}
            return {
                "min_freq_mhz": freq_range.get("min", 0),
                "max_freq_mhz": freq_range.get("max", notches[-1] if notches else 0),
                "load_min": load_target.get("lower", 0.5),
                "load_max": load_target.get("upper", 0.65),
                "temp_throttling": temperature.get("throttling", 85),
                "temp_recovery": temperature.get("throttling_recovery", 75),
            }
        except Exception as e:
            decky.logger.error(f"get_config_defaults error: {e}")
            return {
                "min_freq_mhz": 0,
                "max_freq_mhz": 0,
                "load_min": 0.5,
                "load_max": 0.65,
                "temp_throttling": 85,
                "temp_recovery": 75,
            }

    async def list_profiles(self) -> dict:
        return _load_profiles()

    async def save_profile(self, profile: dict) -> dict:
        try:
            data = _load_profiles()
            profiles = data.get("profiles", [])
            if not profile.get("id"):
                profile["id"] = str(int(time.time() * 1000))
            existing_idx = next(
                (i for i, p in enumerate(profiles) if p["id"] == profile["id"]), None
            )
            if existing_idx is not None:
                profiles[existing_idx] = profile
            else:
                profiles.append(profile)
            data["profiles"] = profiles
            if not data.get("active_id"):
                data["active_id"] = profile["id"]
            _save_profiles(data)
            return {"ok": True, "error": None, "id": profile["id"]}
        except Exception as e:
            decky.logger.error(f"save_profile error: {e}")
            return {"ok": False, "error": str(e), "id": None}

    async def delete_profile(self, profile_id: str) -> dict:
        try:
            data = _load_profiles()
            data["profiles"] = [p for p in data.get("profiles", []) if p["id"] != profile_id]
            if data.get("active_id") == profile_id:
                remaining = data["profiles"]
                data["active_id"] = remaining[0]["id"] if remaining else None
            _save_profiles(data)
            return {"ok": True, "error": None}
        except Exception as e:
            decky.logger.error(f"delete_profile error: {e}")
            return {"ok": False, "error": str(e)}

    async def set_active_profile(self, profile_id: str) -> dict:
        try:
            data = _load_profiles()
            profile = next(
                (p for p in data.get("profiles", []) if p["id"] == profile_id), None
            )
            if not profile:
                return {"ok": False, "error": "Profile not found"}
            data["active_id"] = profile_id
            _save_profiles(data)
            return await self._apply_profile(profile)
        except Exception as e:
            decky.logger.error(f"set_active_profile error: {e}")
            return {"ok": False, "error": str(e)}

    async def _apply_profile(self, profile: dict) -> dict:
        min_freq = profile.get("min_freq_mhz", 0)
        max_freq = profile.get("max_freq_mhz", 0)
        load_min = float(profile.get("load_min", 0.5))
        load_max = float(profile.get("load_max", 0.9))
        throttle = profile.get("temp_throttling", 85)
        recovery = profile.get("temp_recovery", 75)
        try:
            proc = await asyncio.create_subprocess_exec(
                "busctl", "--system", "call",
                GOVERNOR_SERVICE,
                GOVERNOR_OBJECT,
                GOVERNOR_IFACE,
                "SetParameters",
                "uuffuu",
                str(min_freq), str(max_freq),
                str(load_min), str(load_max),
                str(throttle), str(recovery),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_CLEAN_ENV,
            )
            _, stderr_bytes = await proc.communicate()
            if proc.returncode == 0:
                decky.logger.info(
                    f"_apply_profile: applied '{profile.get('name')}' "
                    f"({min_freq}-{max_freq} MHz, load {load_min}-{load_max}, "
                    f"temp {throttle}/{recovery}°C)"
                )
                return {"ok": True, "error": None}
            else:
                stderr = stderr_bytes.decode(errors="replace").strip()
                decky.logger.error(f"_apply_profile: busctl failed: {stderr}")
                return {"ok": False, "error": stderr or f"busctl exited with code {proc.returncode}"}
        except Exception as e:
            decky.logger.error(f"_apply_profile error: {e}")
            return {"ok": False, "error": str(e)}

    async def apply_cap(self, freq_mhz: int) -> dict:
        try:
            notches = self._notches
            if not notches:
                return {"ok": False, "error": "Notch list not loaded; open the plugin panel first."}
            if freq_mhz < notches[0] or freq_mhz > notches[-1]:
                decky.logger.error(f"apply_cap: frequency {freq_mhz} out of range [{notches[0]}, {notches[-1]}]")
                return {"ok": False, "error": "Frequency out of range"}

            data = _load_profiles()
            active_id = data.get("active_id")
            min_freq = 0

            if active_id:
                profiles = data.get("profiles", [])
                for i, p in enumerate(profiles):
                    if p["id"] == active_id:
                        min_freq = p.get("min_freq_mhz", 0)
                        profiles[i]["cap_freq_mhz"] = freq_mhz
                        break
                data["profiles"] = profiles
                _save_profiles(data)

            proc = await asyncio.create_subprocess_exec(
                "busctl", "--system", "call",
                GOVERNOR_SERVICE,
                GOVERNOR_OBJECT,
                GOVERNOR_IFACE,
                "SetRange",
                "uu", str(min_freq), str(freq_mhz),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_CLEAN_ENV,
            )
            _, stderr_bytes = await proc.communicate()

            if proc.returncode == 0:
                decky.logger.info(f"apply_cap: set range to {min_freq}-{freq_mhz} MHz")
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
        gpu_load_pct = None
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
            for metrics_path in glob.glob("/sys/class/drm/card*/device/gpu_metrics"):
                with open(metrics_path, "rb") as f:
                    data = f.read()
                if len(data) < 30 or data[2] != 2:
                    continue
                def _field(o):
                    v = struct.unpack_from("<H", data, o)[0]
                    return None if v == 0xFFFF else v
                raw = _field(28)
                if raw is not None:
                    gpu_load_pct = round(raw / 100.0)
                break
        except Exception as e:
            decky.logger.error(f"get_telemetry gpu_metrics error: {e}")

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
            "gpu_load_pct": gpu_load_pct,
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
                    profiles_data = _load_profiles()

                    # Auto-create a Default profile from TOML on first run
                    if not profiles_data.get("profiles"):
                        defaults = await self.get_config_defaults()
                        default_profile = {
                            "id": str(int(time.time() * 1000)),
                            "name": "Default",
                            **defaults,
                        }
                        profiles_data["profiles"] = [default_profile]
                        profiles_data["active_id"] = default_profile["id"]
                        _save_profiles(profiles_data)
                        decky.logger.info("_main: created Default profile from TOML config")

                    active_id = profiles_data.get("active_id")
                    if not active_id:
                        decky.logger.info("_main: no active profile, skipping re-apply")
                    else:
                        active = next(
                            (p for p in profiles_data.get("profiles", []) if p["id"] == active_id),
                            None,
                        )
                        if not active:
                            decky.logger.info("_main: active profile not found in profiles list")
                        else:
                            result = await self._apply_profile(active)
                            if not result["ok"]:
                                decky.logger.error(f"_main: failed to re-apply profile: {result['error']}")
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
