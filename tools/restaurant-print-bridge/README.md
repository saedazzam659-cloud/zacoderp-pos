# Restaurant Print Bridge (Windows)

This is a separate local helper for the web restaurant POS. It does not use or launch POS Desktop.

## Start

Install Node.js 20 or newer on the Windows computer that can access the branch printers. In PowerShell:

```powershell
$env:BRIDGE_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:WEB_ORIGIN = "https://your-published-pos-domain"
node .\server.mjs
```

Keep the token private. Enter it in the restaurant printer settings when connecting to the local helper. The helper binds to `127.0.0.1` and does not expose a listener to the branch network.

The current helper exposes printer discovery, a health check, and a test-print endpoint. Automatic kitchen ticket polling and acknowledgement are not included yet; the web app must not be treated as automatically printing orders until that queue integration is added.

## Endpoints

- `GET /health`
- `GET /printers`
- `POST /test-print` with `{ "printerName": "Windows printer name" }`

All endpoints require `Authorization: Bearer <BRIDGE_TOKEN>`. Set `WEB_ORIGIN` to the exact origin used by the browser.
