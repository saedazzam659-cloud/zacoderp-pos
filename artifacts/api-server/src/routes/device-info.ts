import { Router } from "express";
import os from "os";
import { execSync } from "child_process";

const router = Router();

function tryRead(fn: () => string): string {
  try {
    return fn().trim();
  } catch {
    return "";
  }
}

function readLinuxDmi(field: string): string {
  return tryRead(() => {
    const result = execSync(`cat /sys/class/dmi/id/${field} 2>/dev/null`, { timeout: 2000 }).toString();
    return result;
  });
}

function readWindowsWmic(field: string): string {
  return tryRead(() => {
    const result = execSync(`wmic ${field} 2>nul`, { timeout: 5000 }).toString();
    const lines = result.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[1] || "";
  });
}

router.get("/device-info", (_req, res) => {
  const platform = os.platform();
  const hostname = os.hostname();
  const arch = os.arch();
  const nodeVersion = process.version;
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0]?.model || "" : "";

  let manufacturer = "";
  let model = "";
  let serial = "";
  let osName = "";
  let totalRam = Math.round(os.totalmem() / (1024 * 1024 * 1024));

  if (platform === "linux") {
    manufacturer = readLinuxDmi("sys_vendor") || readLinuxDmi("board_vendor") || "Linux Server";
    model = readLinuxDmi("product_name") || readLinuxDmi("board_name") || hostname;
    serial = readLinuxDmi("product_serial") || readLinuxDmi("board_serial") || "";
    osName = tryRead(() =>
      execSync("cat /etc/os-release | grep PRETTY_NAME | cut -d'\"' -f2 2>/dev/null", { timeout: 2000 }).toString()
    ) || "Linux";
  } else if (platform === "win32") {
    manufacturer = readWindowsWmic("csproduct get vendor") || readWindowsWmic("computersystem get manufacturer");
    model = readWindowsWmic("csproduct get name") || readWindowsWmic("computersystem get model");
    serial = readWindowsWmic("bios get serialnumber");
    osName = tryRead(() =>
      execSync("ver", { timeout: 2000, shell: "cmd.exe" }).toString()
    ) || "Windows";
  } else if (platform === "darwin") {
    manufacturer = "Apple";
    model = tryRead(() =>
      execSync("sysctl -n hw.model 2>/dev/null", { timeout: 2000 }).toString()
    );
    serial = tryRead(() =>
      execSync(
        "ioreg -l | grep IOPlatformSerialNumber | awk '{print $4}' | tr -d '\"'",
        { timeout: 2000 }
      ).toString()
    );
    osName = tryRead(() =>
      execSync("sw_vers -productVersion 2>/dev/null", { timeout: 2000 }).toString()
    );
    osName = osName ? `macOS ${osName}` : "macOS";
  }

  // Clean up common placeholder values that mean "not set"
  const badValues = ["to be filled by o.e.m.", "to be filled by oem", "n/a", "none", "0", "default string", ""];
  const clean = (v: string) => (badValues.includes(v.toLowerCase()) ? "" : v);

  manufacturer = clean(manufacturer) || "Server";
  model = clean(model) || hostname;
  serial = clean(serial) || `${hostname}-${arch}`;

  // Generate a stable UUID-like identifier from hostname + MAC
  const nets = os.networkInterfaces();
  let macAddr = "";
  for (const interfaces of Object.values(nets)) {
    for (const iface of interfaces || []) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        macAddr = iface.mac.replace(/:/g, "");
        break;
      }
    }
    if (macAddr) break;
  }
  const stableId = macAddr || Buffer.from(hostname).toString("hex").slice(0, 12);

  res.json({
    manufacturer,
    model,
    serial: serial || stableId,
    hostname,
    platform,
    arch,
    osName,
    cpuModel,
    totalRamGb: totalRam,
    nodeVersion,
    stableId,
  });
});

export default router;
