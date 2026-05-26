// Scale (weighing) integration — Task #201.
//
// One-shot read model: each call to `read_weight_once` opens the COM port,
// reads up to ~1.5 s worth of frames, parses with the chosen protocol, and
// closes. No background thread, no port-handle state to manage, no event
// channel — the React side polls every 500ms while the weight-capture
// modal is open. Trade-off: ~50ms of port-open overhead per poll, vs.
// zero risk of leaking a serial handle when the user closes the modal or
// the app crashes mid-read. CAS / Bizerba scales tested in the wild send
// at 9600 baud with continuous frames every ~100ms, so a 1.5 s window
// always catches a stable frame.
//
// Three protocols, all ASCII-framed:
//   - CAS         (CL-/ED- series, "S S \r\n W W . W W kg \r\n")
//   - Bizerba     (BC II / KH series, similar but unit can be 'g'/'kg' and
//                  there's a leading STX/ETX in some variants)
//   - GenericAscii (anything that contains a printable float and optional
//                   unit token — last-resort fallback for off-brand scales)
//
// Embedded-weight barcode parser is also here (pure logic, no I/O).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScaleProtocol {
    Cas,
    Bizerba,
    GenericAscii,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Weight {
    /// Always normalized to kilograms.
    pub value_kg: f64,
    /// True when the scale flagged the reading as stable (frame contains
    /// "ST" / no motion marker). Generic-ASCII has no stable bit, so it
    /// always reports true — caller must use weight-change tolerance instead.
    pub stable: bool,
    /// Echo of the raw frame for diagnostics (trimmed, first 32 chars).
    pub raw: String,
}

// ─── Protocol parsers (pure, hardware-independent) ───────────────────

/// Parse a single line from a CAS / generic ascii scale.
/// Examples that should parse to 1.234 kg:
///   "S S 1.234 kg"   (CAS continuous mode)
///   "ST,GS,  1.234kg" (CAS dialog mode)
///   "  1.234 kg "    (Generic)
///   "1234 g"         (Generic — grams → 1.234 kg)
pub fn parse_generic_ascii(line: &str) -> Option<Weight> {
    let trimmed = line.trim_matches(|c: char| c.is_control() || c.is_whitespace());
    if trimmed.is_empty() { return None; }

    // Stable bit: look for "ST" anywhere in the frame (CAS convention).
    let stable_marker = trimmed.to_uppercase();
    let stable = stable_marker.contains("ST") || !stable_marker.contains("US");

    // Pull out the first numeric token (allowing sign + decimal).
    let mut num_start: Option<usize> = None;
    let mut num_end: usize = trimmed.len();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if num_start.is_none() {
            if c == '-' || c == '+' || c.is_ascii_digit() { num_start = Some(i); }
        } else {
            if !(c.is_ascii_digit() || c == '.') { num_end = i; break; }
        }
        i += 1;
    }
    let s = num_start?;
    let num_str = &trimmed[s..num_end];
    let value: f64 = num_str.parse().ok()?;

    // Unit detection — default kg.
    let lower = trimmed[num_end..].trim_start().to_lowercase();
    let value_kg = if lower.starts_with("kg") {
        value
    } else if lower.starts_with('g') && !lower.starts_with("gs") {
        value / 1000.0
    } else if lower.starts_with("lb") {
        value * 0.45359237
    } else {
        // No unit → assume kg (CAS continuous mode often omits the unit
        // after the first frame).
        value
    };

    // Sanity bounds — anything beyond 1000 kg is almost certainly garbage.
    if !value_kg.is_finite() || value_kg.abs() > 1000.0 { return None; }

    Some(Weight {
        value_kg,
        stable,
        raw: trimmed.chars().take(32).collect(),
    })
}

/// CAS protocol: same numeric format as generic, but with strict ST/US
/// stable flag handling and the optional STX/ETX framing.
pub fn parse_cas(line: &str) -> Option<Weight> {
    // Strip STX (0x02) / ETX (0x03) if present.
    let cleaned: String = line
        .chars()
        .filter(|&c| c != '\x02' && c != '\x03')
        .collect();
    let mut w = parse_generic_ascii(&cleaned)?;
    let upper = cleaned.to_uppercase();
    // CAS-specific: be strict about stability. Only "ST" means stable;
    // "US" (unstable) explicitly clears it.
    w.stable = upper.contains("ST") && !upper.contains("US");
    Some(w)
}

/// Bizerba: similar ASCII but the frame is wrapped in STX/ETX and units
/// are often abbreviated lowercase. Fall through to generic parse for
/// the numeric extraction.
pub fn parse_bizerba(line: &str) -> Option<Weight> {
    parse_cas(line)
}

pub fn parse_with(protocol: ScaleProtocol, line: &str) -> Option<Weight> {
    match protocol {
        ScaleProtocol::Cas => parse_cas(line),
        ScaleProtocol::Bizerba => parse_bizerba(line),
        ScaleProtocol::GenericAscii => parse_generic_ascii(line),
    }
}

// ─── Embedded-weight barcode parser (pure) ──────────────────────────
//
// EAN-13 with leading prefix 2X (X = 0..9) carries a PLU + weight + check
// digits. Configuration tells us where each segment is and how many
// implicit decimals the weight has.

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedWeightCfg {
    /// Two-digit prefix that marks an embedded-weight barcode (e.g. "20").
    pub prefix: String,
    /// Number of PLU digits after the prefix (typically 5).
    pub plu_len: u8,
    /// Number of weight digits (typically 5).
    pub weight_len: u8,
    /// Number of implicit decimals in the weight field (3 → grams, 2 → 10g).
    pub weight_decimals: u8,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedWeightHit {
    pub plu: String,
    pub weight_kg: f64,
}

pub fn parse_embedded_weight(barcode: &str, cfg: &EmbeddedWeightCfg) -> Option<EmbeddedWeightHit> {
    if !barcode.starts_with(&cfg.prefix) { return None; }
    let total_needed = cfg.prefix.len() + cfg.plu_len as usize + cfg.weight_len as usize;
    if barcode.len() < total_needed { return None; }
    let after_prefix = &barcode[cfg.prefix.len()..];
    let plu = &after_prefix[..cfg.plu_len as usize];
    let weight_str = &after_prefix[cfg.plu_len as usize..cfg.plu_len as usize + cfg.weight_len as usize];
    if !plu.chars().all(|c| c.is_ascii_digit()) || !weight_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let raw: f64 = weight_str.parse().ok()?;
    let weight_kg = raw / 10f64.powi(cfg.weight_decimals as i32);
    if weight_kg <= 0.0 || weight_kg > 1000.0 { return None; }
    Some(EmbeddedWeightHit { plu: plu.to_string(), weight_kg })
}

// ─── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn list_scale_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

/// Open the COM port, read until we have a parseable frame or the
/// 1500 ms window elapses, then close. Returns Err on hardware-level
/// failures (port not found, permission denied) so the UI can show a
/// clear "ميزان غير متصل" message; returns Ok(None) when the port
/// opened but no frame was readable in time (typical when the scale is
/// powered but not yet sending — e.g. the user hasn't placed anything).
#[tauri::command]
pub fn read_weight_once(
    port: String,
    baud: u32,
    protocol: ScaleProtocol,
) -> Result<Option<Weight>, String> {
    read_once(&port, baud, protocol).map_err(|e| e.to_string())
}

fn read_once(port: &str, baud: u32, protocol: ScaleProtocol) -> Result<Option<Weight>> {
    let mut handle = serialport::new(port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| anyhow!("فشل فتح المنفذ {}: {}", port, e))?;

    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut acc: Vec<u8> = Vec::with_capacity(256);
    let mut buf = [0u8; 128];
    let mut best: Option<Weight> = None;

    while Instant::now() < deadline {
        match handle.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => {
                acc.extend_from_slice(&buf[..n]);
                // Process complete lines as they arrive.
                while let Some(idx) = acc.iter().position(|&b| b == b'\n' || b == b'\r' || b == 0x03) {
                    let line_bytes: Vec<u8> = acc.drain(..=idx).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
                    if let Some(w) = parse_with(protocol, &line) {
                        // Prefer a stable reading over an unstable one.
                        if w.stable { return Ok(Some(w)); }
                        best = Some(w);
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // No data in this 200ms window — keep looping until deadline.
                continue;
            }
            Err(e) => return Err(anyhow!("قراءة المنفذ فشلت: {}", e)),
        }
    }
    // Fall back: try parsing whatever is buffered (no terminator).
    if best.is_none() && !acc.is_empty() {
        let line = String::from_utf8_lossy(&acc);
        best = parse_with(protocol, &line);
    }
    Ok(best)
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_continuous_stable() {
        let w = parse_cas("ST,GS,  1.234kg\r\n").unwrap();
        assert!((w.value_kg - 1.234).abs() < 1e-6);
        assert!(w.stable);
    }

    #[test]
    fn cas_unstable() {
        let w = parse_cas("US,GS,  0.500kg\r\n").unwrap();
        assert!(!w.stable);
    }

    #[test]
    fn bizerba_with_stx_etx() {
        let raw = format!("\x02 1.500 kg \x03");
        let w = parse_bizerba(&raw).unwrap();
        assert!((w.value_kg - 1.500).abs() < 1e-6);
    }

    #[test]
    fn generic_grams_to_kg() {
        let w = parse_generic_ascii("250 g\r\n").unwrap();
        assert!((w.value_kg - 0.250).abs() < 1e-6);
    }

    #[test]
    fn generic_no_unit_default_kg() {
        let w = parse_generic_ascii("  2.75  ").unwrap();
        assert!((w.value_kg - 2.75).abs() < 1e-6);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_generic_ascii("hello world").is_none());
        assert!(parse_generic_ascii("").is_none());
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(parse_generic_ascii("99999 kg").is_none());
    }

    #[test]
    fn embedded_weight_basic() {
        // Prefix=20, PLU=00123, weight=01234 (3 decimals → 1.234 kg)
        let cfg = EmbeddedWeightCfg {
            prefix: "20".into(), plu_len: 5, weight_len: 5, weight_decimals: 3,
        };
        let h = parse_embedded_weight("2000123012340", &cfg).unwrap();
        assert_eq!(h.plu, "00123");
        assert!((h.weight_kg - 1.234).abs() < 1e-6);
    }

    #[test]
    fn embedded_weight_wrong_prefix() {
        let cfg = EmbeddedWeightCfg {
            prefix: "20".into(), plu_len: 5, weight_len: 5, weight_decimals: 3,
        };
        assert!(parse_embedded_weight("6281234567890", &cfg).is_none());
    }

    #[test]
    fn embedded_weight_two_decimals() {
        let cfg = EmbeddedWeightCfg {
            prefix: "22".into(), plu_len: 4, weight_len: 5, weight_decimals: 2,
        };
        let h = parse_embedded_weight("2200770012345", &cfg).unwrap();
        assert_eq!(h.plu, "0077");
        assert!((h.weight_kg - 123.45).abs() < 1e-6);
    }
}
