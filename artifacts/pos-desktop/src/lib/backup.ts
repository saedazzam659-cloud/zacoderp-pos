// Frontend wrappers for the native backup / restore / data-folder commands.
// All calls go through the Tauri shim; in a non-Tauri (browser preview) build
// the shim falls back to stubs, so callers must tolerate empty results.
import { invoke } from "./tauri-shim";

export type BackupSettings = {
  autoEnabled: boolean;
  autoTime: string; // "HH:MM"
  backupDir: string; // "" = not chosen
  lastBackupAt: string; // ISO, "" = never
  dataDir: string; // current effective data root
  defaultDataDir: string;
  isCustomDataDir: boolean;
};

export async function getBackupSettings(): Promise<BackupSettings> {
  return invoke<BackupSettings>("backup_get_settings");
}

export async function setBackupSettings(s: {
  autoEnabled: boolean;
  autoTime: string;
  backupDir: string;
}): Promise<void> {
  await invoke("backup_set_settings", {
    autoEnabled: s.autoEnabled,
    autoTime: s.autoTime,
    backupDir: s.backupDir,
  });
}

// Run a backup immediately into the configured auto-backup folder.
export async function runBackupNow(): Promise<string> {
  return invoke<string>("backup_run_now");
}

// Native "Save As" export. Returns the chosen path, or null if cancelled.
export async function exportBackup(): Promise<string | null> {
  return invoke<string | null>("backup_export");
}

// Native open + restore OVER the live db. Returns the chosen path, or null.
export async function importBackup(): Promise<string | null> {
  return invoke<string | null>("backup_import");
}

// Native folder picker. Returns the chosen folder, or null if cancelled.
export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

// Relocate the data folder (moves the db + writes the pointer). Pass null to
// revert to the default location. Returns the new db file path.
export async function setDataDir(dir: string | null): Promise<string> {
  return invoke<string>("data_dir_set", { dir });
}
