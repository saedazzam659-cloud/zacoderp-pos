// POS peripherals: thermal printer (ESC/POS) + cash drawer kick.
// Targets Windows print spooler via `printers` crate, plus serial (COM) fallback.
// Barcode scanners are keyboard-wedge devices → handled in JS, no Rust needed.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

// ─── ESC/POS byte sequences ──────────────────────────────────────────
// Reference: Epson ESC/POS Command Reference (TM-T88V family).
const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;
const LF: u8 = 0x0A;

fn init() -> Vec<u8> { vec![ESC, b'@'] }                        // initialize printer
fn align_center() -> Vec<u8> { vec![ESC, b'a', 1] }
fn align_left() -> Vec<u8> { vec![ESC, b'a', 0] }
fn bold_on() -> Vec<u8> { vec![ESC, b'E', 1] }
fn bold_off() -> Vec<u8> { vec![ESC, b'E', 0] }
fn cut_paper() -> Vec<u8> { vec![GS, b'V', 0] }                 // full cut
fn feed(lines: u8) -> Vec<u8> { vec![ESC, b'd', lines] }
fn kick_drawer() -> Vec<u8> { vec![ESC, b'p', 0, 25, 250] }     // pin 2, on=25ms, off=250ms

// QR via GS ( k — model 2.
fn qr_bytes(data: &str) -> Vec<u8> {
    let mut out = Vec::new();
    // Model 2
    out.extend_from_slice(&[GS, b'(', b'k', 4, 0, 49, 65, 50, 0]);
    // Size (1-16, 6 ≈ medium)
    out.extend_from_slice(&[GS, b'(', b'k', 3, 0, 49, 67, 6]);
    // Error correction L
    out.extend_from_slice(&[GS, b'(', b'k', 3, 0, 49, 69, 48]);
    // Store data
    let len = data.len() + 3;
    out.extend_from_slice(&[GS, b'(', b'k', (len & 0xFF) as u8, (len >> 8) as u8, 49, 80, 48]);
    out.extend_from_slice(data.as_bytes());
    // Print
    out.extend_from_slice(&[GS, b'(', b'k', 3, 0, 49, 81, 48]);
    out
}

// ─── Public types ────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReceiptLine {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub center: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReceiptJob {
    pub printer_name: String,
    pub header: Vec<ReceiptLine>,
    pub body: Vec<ReceiptLine>,
    pub footer: Vec<ReceiptLine>,
    #[serde(default)]
    pub qr_data: Option<String>,
    #[serde(default)]
    pub open_drawer: bool,
    #[serde(default)]
    pub cut: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PrinterInfo {
    pub name: String,
    pub system_name: String,
    pub is_default: bool,
    pub state: String,
}

// ─── Render a job into raw ESC/POS bytes ─────────────────────────────
pub fn render_receipt(job: &ReceiptJob) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1024);
    buf.extend(init());

    let render_section = |buf: &mut Vec<u8>, lines: &[ReceiptLine]| {
        for line in lines {
            if line.center { buf.extend(align_center()); } else { buf.extend(align_left()); }
            if line.bold { buf.extend(bold_on()); }
            buf.extend_from_slice(line.text.as_bytes());
            buf.push(LF);
            if line.bold { buf.extend(bold_off()); }
        }
    };

    render_section(&mut buf, &job.header);
    buf.extend(feed(1));
    render_section(&mut buf, &job.body);
    buf.extend(feed(1));
    render_section(&mut buf, &job.footer);

    if let Some(qr) = &job.qr_data {
        buf.extend(align_center());
        buf.extend(qr_bytes(qr));
        buf.push(LF);
    }

    buf.extend(feed(3));
    if job.cut { buf.extend(cut_paper()); }
    if job.open_drawer { buf.extend(kick_drawer()); }
    buf
}

// ─── Send raw bytes to a Windows print spooler queue ─────────────────
fn print_via_spooler(printer_name: &str, bytes: &[u8]) -> Result<()> {
    use printers::get_printers;
    let target = get_printers()
        .into_iter()
        .find(|p| p.name == printer_name || p.system_name == printer_name)
        .ok_or_else(|| anyhow!("printer not found: {}", printer_name))?;
    target
        .print(bytes, Some("ZACOD POS Receipt"))
        .map_err(|e| anyhow!("spooler print failed: {:?}", e))?;
    Ok(())
}

// ─── Send raw bytes to a serial (COM) port directly ──────────────────
fn print_via_serial(port: &str, baud: u32, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut port = serialport::new(port, baud)
        .timeout(Duration::from_millis(2000))
        .open()
        .map_err(|e| anyhow!("open serial {}: {}", port, e))?;
    port.write_all(bytes).map_err(|e| anyhow!("serial write: {}", e))?;
    port.flush().map_err(|e| anyhow!("serial flush: {}", e))?;
    Ok(())
}

// ─── Tauri commands ──────────────────────────────────────────────────
#[tauri::command]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    use printers::get_printers;
    Ok(get_printers()
        .into_iter()
        .map(|p| PrinterInfo {
            name: p.name.clone(),
            system_name: p.system_name.clone(),
            is_default: p.is_default,
            state: format!("{:?}", p.state),
        })
        .collect())
}

#[tauri::command]
pub fn print_receipt(job: ReceiptJob) -> Result<(), String> {
    let bytes = render_receipt(&job);
    print_via_spooler(&job.printer_name, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn print_raw_serial(port: String, baud: u32, bytes: Vec<u8>) -> Result<(), String> {
    print_via_serial(&port, baud, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_cash_drawer(printer_name: String) -> Result<(), String> {
    let bytes: Vec<u8> = init().into_iter().chain(kick_drawer()).collect();
    print_via_spooler(&printer_name, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_cash_drawer_serial(port: String, baud: u32) -> Result<(), String> {
    let bytes: Vec<u8> = init().into_iter().chain(kick_drawer()).collect();
    print_via_serial(&port, baud, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

// ─── Inline tests for byte sequences (no hardware required) ──────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_bytes() {
        assert_eq!(init(), vec![0x1B, 0x40]);
    }

    #[test]
    fn drawer_kick_pin2() {
        assert_eq!(kick_drawer(), vec![0x1B, 0x70, 0x00, 25, 250]);
    }

    #[test]
    fn cut_is_gs_v_0() {
        assert_eq!(cut_paper(), vec![0x1D, 0x56, 0x00]);
    }

    #[test]
    fn qr_envelope_contains_data() {
        let out = qr_bytes("HELLO");
        assert!(out.windows(5).any(|w| w == b"HELLO"));
        assert!(out.starts_with(&[0x1D, 0x28, 0x6B]));
    }

    #[test]
    fn render_includes_header_body_footer() {
        let job = ReceiptJob {
            printer_name: "X".into(),
            header: vec![ReceiptLine { text: "ZACOD".into(), bold: true, center: true }],
            body: vec![ReceiptLine { text: "Item 1".into(), bold: false, center: false }],
            footer: vec![ReceiptLine { text: "شكرا".into(), bold: false, center: true }],
            qr_data: Some("https://x".into()),
            open_drawer: true,
            cut: true,
        };
        let bytes = render_receipt(&job);
        assert!(bytes.windows(5).any(|w| w == b"ZACOD"));
        assert!(bytes.windows(6).any(|w| w == b"Item 1"));
        // ends with cut + kick somewhere near the end
        assert!(bytes.windows(3).any(|w| w == [0x1D, 0x56, 0x00]));
        assert!(bytes.windows(5).any(|w| w == [0x1B, 0x70, 0x00, 25, 250]));
    }
}
