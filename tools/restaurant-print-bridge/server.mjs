import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT ?? 3217);
const token = process.env.BRIDGE_TOKEN ?? "";
const allowedOrigin = process.env.WEB_ORIGIN ?? "";
const apiBase = (process.env.POS_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
const printedJobsPath = process.env.PRINTED_JOBS_PATH ?? path.join(process.cwd(), "printed-kitchen-jobs.json");
const printedJobIds = new Set();
let printedJobsLoaded = false;

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

async function printTicket(printerName, payload) {
  const lines = [
    `طلب المطبخ: ${payload.orderNumber}`,
    `المحطة: ${payload.stationName}`,
    payload.tableName ? `الطاولة: ${payload.tableName}` : "",
    "------------------------------",
    ...(payload.items ?? []).flatMap(item => [
      `${item.qty} × ${item.name}`,
      ...(item.modifiers ?? []).map(modifier => `  - ${modifier.option}`),
      ...(item.notes ? [`  ملاحظة: ${item.notes}`] : []),
    ]),
    "",
  ].filter(Boolean);
  const encodedName = Buffer.from(printerName, "utf16le").toString("base64");
  const encodedLines = Buffer.from(JSON.stringify(lines), "utf8").toString("base64");
  const script = `
    Add-Type -AssemblyName System.Drawing
    $name = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedName}'))
    $lines = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLines}')) | ConvertFrom-Json
    $doc = New-Object System.Drawing.Printing.PrintDocument
    $doc.PrinterSettings.PrinterName = $name
    if (-not $doc.PrinterSettings.IsValid) { throw "Printer is unavailable" }
    $doc.add_PrintPage({
      param($sender, $event)
      $font = New-Object System.Drawing.Font('Arial', 12)
      $fmt = New-Object System.Drawing.StringFormat
      $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::DirectionRightToLeft
      $fmt.Alignment = [System.Drawing.StringAlignment]::Far
      $y = [single]20
      foreach ($line in $lines) {
        $event.Graphics.DrawString([string]$line, $font, [System.Drawing.Brushes]::Black, [single]10, $y, $fmt)
        $y += 24
      }
    })
    $doc.Print()
    $doc.Dispose()
  `;
  await runPowerShell(script);
}

async function loadPrintedJobs() {
  if (printedJobsLoaded) return;
  printedJobsLoaded = true;
  try {
    const ids = JSON.parse(await readFile(printedJobsPath, "utf8"));
    if (Array.isArray(ids)) for (const id of ids) printedJobIds.add(String(id));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function rememberPrintedJob(id) {
  printedJobIds.add(String(id));
  const temporaryPath = `${printedJobsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify([...printedJobIds]), { encoding: "utf8" });
  await rename(temporaryPath, printedJobsPath);
}

async function pollPrintJobs() {
  if (!apiBase || pollPrintJobs.busy) return;
  pollPrintJobs.busy = true;
  try {
    await loadPrintedJobs();
    const headers = { Authorization: `Bearer ${token}` };
    const jobResponse = await fetch(`${apiBase}/api/pos-restaurant/print-bridge/jobs/next`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!jobResponse.ok) throw new Error(`Queue request failed (${jobResponse.status})`);
    const { job } = await jobResponse.json();
    if (!job) return;
    let printError = "";
    let printed = printedJobIds.has(String(job.id));
    if (!printed) {
      for (const printerName of [job.payload.primaryPrinterName, job.payload.backupPrinterName].filter(Boolean)) {
        try {
          await printTicket(printerName, job.payload);
          printed = true;
          break;
        } catch (error) {
          printError += `${printerName}: ${error instanceof Error ? error.message : String(error)}; `;
        }
      }
      if (printed) await rememberPrintedJob(job.id);
    }
    const result = await fetch(`${apiBase}/api/pos-restaurant/print-bridge/jobs/${job.id}/result`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ success: printed, error: printError }),
      signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error(`Could not acknowledge job ${job.id} (${result.status})`);
    if (!printed) process.stderr.write(`Kitchen print job ${job.id} failed on primary and backup.\n`);
  } catch (error) {
    process.stderr.write(`Kitchen print queue: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    pollPrintJobs.busy = false;
  }
}
pollPrintJobs.busy = false;

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
      await printTicket(printerName, {
        orderNumber: "اختبار",
        stationName: "طباعة مطبخ المطعم",
        tableName: new Date().toLocaleString(),
        items: [],
      });
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
if (apiBase) setInterval(() => { void pollPrintJobs(); }, 2000);
