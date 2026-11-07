import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT ?? 3217);
const token = process.env.BRIDGE_TOKEN ?? "";
const allowedOrigin = process.env.WEB_ORIGIN ?? "";

if (process.platform !== "win32") {
  throw new Error("Restaurant Print Bridge currently supports Windows only.");
}
if (token.length < 32) {
  throw new Error("Set BRIDGE_TOKEN to a random value of at least 32 characters.");
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `PowerShell exited with ${code}`)));
  });
}

function equalToken(candidate) {
  const left = Buffer.from(token);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  if (origin && allowedOrigin && origin !== allowedOrigin) return send(res, 403, { error: "Origin not allowed" });
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (!equalToken((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))) {
    return send(res, 401, { error: "Unauthorized" });
  }

  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, platform: "windows" });
    if (req.method === "GET" && req.url === "/printers") {
      const output = await runPowerShell(
        "Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress",
      );
      const printers = output.trim() ? JSON.parse(output) : [];
      return send(res, 200, { printers: Array.isArray(printers) ? printers : [printers] });
    }
    if (req.method === "POST" && req.url === "/test-print") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return send(res, 413, { error: "Request too large" });
      }
      const input = JSON.parse(body || "{}");
      const printerName = String(input.printerName ?? "").trim();
      if (!printerName || printerName.length > 200) return send(res, 400, { error: "Invalid printer name" });
      const encodedName = Buffer.from(printerName, "utf16le").toString("base64");
      const script = `
        $name = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedName}'))
        $printer = Get-Printer -Name $name -ErrorAction Stop
        $doc = New-Object System.Drawing.Printing.PrintDocument
        $doc.PrinterSettings.PrinterName = $printer.Name
        if (-not $doc.PrinterSettings.IsValid) { throw "Printer is unavailable" }
        $doc.add_PrintPage({
          param($sender, $event)
          $font = New-Object System.Drawing.Font('Arial', 12)
          $brush = [System.Drawing.Brushes]::Black
          $event.Graphics.DrawString('اختبار طباعة مطبخ المطعم', $font, $brush, 20, 20)
          $event.Graphics.DrawString([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'), $font, $brush, 20, 50)
        })
        $doc.Print()
        $doc.Dispose()
      `;
      await runPowerShell(`Add-Type -AssemblyName System.Drawing; ${script}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 502, { error: error instanceof Error ? error.message : "Printer operation failed" });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Restaurant Print Bridge listening on http://${host}:${port}\n`);
});
