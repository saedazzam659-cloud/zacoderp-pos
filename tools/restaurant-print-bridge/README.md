# Restaurant Print Bridge (Windows)

This is a separate local helper for the web restaurant POS. It does not use or launch POS Desktop.

## Start

Install Node.js 20 or newer on the Windows computer that can access the branch printers. In restaurant settings, generate a branch token and copy it to PowerShell along with the published API origin and the exact web origin:

```powershell
$env:BRIDGE_TOKEN = "<token generated in restaurant settings>"
$env:POS_API_URL = "https://your-published-pos-domain"
$env:WEB_ORIGIN = "https://your-published-pos-domain"
node .\server.mjs
```

Keep the token private. It is shown once in restaurant settings and stored hashed on the server. The helper binds to `127.0.0.1` and does not expose a listener to the branch network.

The helper exposes printer discovery, test printing, and an outbound poller for branch kitchen tickets. It tries the primary printer first, then the backup, and reports the result to the API. The service only polls when `POS_API_URL` is set.

## Endpoints

- `GET /health`
- `GET /printers`
- `POST /test-print` with `{ "printerName": "Windows printer name" }`
- Outbound API polling at `/api/pos-restaurant/print-bridge/jobs/next`

Local endpoints require `Authorization: Bearer <BRIDGE_TOKEN>`. Set `WEB_ORIGIN` to the exact origin used by the browser. Orders enter the print queue when staff sends new items to the kitchen; configure a primary printer for each station to enable routing.
