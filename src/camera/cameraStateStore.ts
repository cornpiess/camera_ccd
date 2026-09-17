import { File, Paths } from 'expo-file-system';

/**
 * Tiny persisted camera state.
 * - lastProfileId: restored on the next launch.
 * - lastThumbUri: stable Documents path of the latest thumbnail.
 * (The per-profile aperture memory from Iteration 4 was removed with the
 * recommended-aperture default: selecting a camera now always snaps to the profile's
 * aperture.preferred per product decision 2026-09-13.)
 * Failures are swallowed by design: a broken preference file must never block the camera.
 */
export interface CameraState {
  lastProfileId: string | null;
  /** Stable Documents path of the latest thumbnail (survives restarts). */
  lastThumbUri?: string | null;
}

const STATE_FILENAME = 'camera-state.json';

const file = (): File => new File(Paths.document, STATE_FILENAME);

export async function loadCameraState(): Promise<CameraState> {
  try {
    const f = file();
    if (!f.exists) return { lastProfileId: null, lastThumbUri: null };
    const parsed = JSON.parse(await f.text()) as Partial<CameraState> | null;
    return {
      lastThumbUri: typeof parsed?.lastThumbUri === 'string' ? parsed.lastThumbUri : null,
      lastProfileId: typeof parsed?.lastProfileId === 'string' ? parsed.lastProfileId : null,
    };
  } catch {
    return { lastProfileId: null, lastThumbUri: null };
  }
}

// SERIALIZED read-merge-write: two overlapping saves (thumbnail write from a capture
// racing the profile-id write from a camera switch) used to each load the OLD file and
// the second write dropped the first patch's field. Chaining through one promise makes
// every save re-read the file after the previous save completed.
let saveChain: Promise<void> = Promise.resolve();

export function saveCameraState(patch: Partial<CameraState>): Promise<void> {
  const run = saveChain.then(async () => {
    try {
      const merged: CameraState = { ...(await loadCameraState()), ...patch };
      file().write(JSON.stringify(merged));
    } catch {
      // Preference persistence is best-effort; never block or crash the camera.
    }
  });
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
