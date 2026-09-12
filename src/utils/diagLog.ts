import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Lightweight on-device diagnostic log (there is no console on a production phone, so the
 * only way to debug device-only failures remotely is to record them here).
 *
 * - Ring buffer of warn/error/fatal messages + startup breadcrumbs (OS version, which Expo
 *   native modules actually registered — the single most useful fact when a native module
 *   "goes missing" between the CI build and the device).
 * - Persisted to Documents/camera18-diag.log, best-effort: a broken logger must never
 *   crash or block the camera.
 * - Read back through getDiagLogText() (StartupErrorBoundary + CalibrationModal), so a
 *   screenshot of the error screen or a copied log block is enough to diagnose remotely.
 *
 * The module self-installs on import and MUST be the first import in App.tsx so that
 * module-evaluation errors from later imports are captured too.
 */

export type DiagLevel = 'info' | 'warn' | 'error' | 'fatal';

interface DiagEntry {
  readonly time: string;
  readonly level: DiagLevel;
  readonly message: string;
}

const MAX_ENTRIES = 300;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PREVIOUS_SESSION_CHARS = 8000;
const LOG_FILENAME = 'camera18-diag.log';

const entries: DiagEntry[] = [];
let previousSessionText = '';
let installed = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

type ExpoGlobalLike = {
  modules?: Record<string, unknown>;
};

function expoGlobal(): ExpoGlobalLike | null {
  return (globalThis as { expo?: ExpoGlobalLike }).expo ?? null;
}

/** Names of Expo native modules registered in the current runtime (empty if the Expo global never installed). */
export function registeredExpoModuleNames(): string {
  const modules = expoGlobal()?.modules;
  if (!modules) return '(expo global not installed)';
  return Object.keys(modules).sort().join(', ') || '(none)';
}

function logFile(): File | null {
  try {
    return new File(Paths.document, LOG_FILENAME);
  } catch {
    return null;
  }
}

function formatEntry(entry: DiagEntry): string {
  return `${entry.time} [${entry.level}] ${entry.message}`;
}

function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}

export function recordDiag(level: DiagLevel, message: string): void {
  entries.push({ time: new Date().toISOString(), level, message: truncateMessage(message) });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  if (level === 'fatal') {
    persistNow();
    return;
  }
  if (persistTimer === null) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 2000);
  }
}

export function persistNow(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const file = logFile();
  if (!file) return;
  try {
    file.write(entries.map(formatEntry).join('\n'));
  } catch {
    // Best-effort persistence; never surface logger failures.
  }
}

function loadPreviousSession(): void {
  const file = logFile();
  if (!file) return;
  try {
    if (!file.exists) return;
    const text = file.textSync();
    previousSessionText =
      text.length > MAX_PREVIOUS_SESSION_CHARS ? `…${text.slice(-MAX_PREVIOUS_SESSION_CHARS)}` : text;
  } catch {
    previousSessionText = '';
  }
}

/** Full log text: the tail of the previous session (if any) followed by this session's entries. */
export function getDiagLogText(): string {
  const current = entries.map(formatEntry).join('\n');
  if (!previousSessionText) return current || '(log is empty)';
  return `${previousSessionText}\n--- current session ---\n${current}`.trim();
}

function joinArgs(args: readonly unknown[]): string {
  return args
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item instanceof Error) return item.stack ?? `${item.name}: ${item.message}`;
      try {
        return JSON.stringify(item) ?? String(item);
      } catch {
        return String(item);
      }
    })
    .join(' ');
}

type RNErrorUtils = {
  setGlobalHandler(handler: (error: Error, isFatal: boolean) => void): void;
  getGlobalHandler?(): (error: Error, isFatal: boolean) => void;
};

function install(): void {
  if (installed) return;
  installed = true;

  loadPreviousSession();

  // Capture console.warn/error without swallowing them from the (dev-only) console.
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: readonly unknown[]) => {
    recordDiag('warn', joinArgs(args));
    originalWarn(...args);
  };
  console.error = (...args: readonly unknown[]) => {
    recordDiag('error', joinArgs(args));
    originalError(...args);
  };

  // Capture uncaught exceptions. Chaining the previous handler keeps RN's own
  // fatal-error behavior intact; our synchronous persist runs before it can abort.
  const errorUtils = (globalThis as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
  if (errorUtils) {
    const previousHandler = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
      recordDiag(isFatal ? 'fatal' : 'error', `Uncaught: ${error?.stack ?? String(error)}`);
      previousHandler?.(error, isFatal);
    });
  }

  const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal;
  recordDiag('info', `diag installed; iOS ${Platform.Version}; hermes: ${Boolean(hermes)}`);
  recordDiag('info', `registered expo modules: ${registeredExpoModuleNames()}`);
}

// Self-install on first import so later module-evaluation errors are captured.
install();

export function installDiagLog(): void {
  // Kept for explicitness; installation already happened at import time.
}
