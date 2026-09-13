import { File, Paths } from 'expo-file-system';

/**
 * Tiny persisted camera state (Iteration 4: the camera should feel like *your* camera).
 * - lastProfileId: restored on the next launch.
 * - lastApertures: per-profile user-chosen f-stop; the JSON preferredAperture is only a
 *   first-touch default and must never override an explicit user choice.
 * Failures are swallowed by design: a broken preference file must never block the camera.
 */
export interface CameraState {
  lastProfileId: string | null;
  lastApertures: Record<string, number>;
  /** Stable Documents path of the latest thumbnail (survives restarts). */
  lastThumbUri?: string | null;
}

const STATE_FILENAME = 'camera-state.json';

const file = (): File => new File(Paths.document, STATE_FILENAME);

export async function loadCameraState(): Promise<CameraState> {
  try {
    const f = file();
    if (!f.exists) return { lastProfileId: null, lastApertures: {} };
    const parsed = JSON.parse(await f.text()) as Partial<CameraState> | null;
    return {
      lastThumbUri: typeof parsed?.lastThumbUri === 'string' ? parsed.lastThumbUri : null,
      lastProfileId: typeof parsed?.lastProfileId === 'string' ? parsed.lastProfileId : null,
      lastApertures:
        parsed?.lastApertures && typeof parsed.lastApertures === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.lastApertures).filter(
                (entry): entry is [string, number] =>
                  typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
              ),
            )
          : {},
    };
  } catch {
    return { lastProfileId: null, lastApertures: {} };
  }
}

export async function saveCameraState(patch: Partial<CameraState>): Promise<void> {
  try {
    const merged: CameraState = { ...(await loadCameraState()), ...patch };
    file().write(JSON.stringify(merged));
  } catch {
    // Preference persistence is best-effort; never block or crash the camera.
  }
}

export async function rememberAperture(profileId: string, aperture: number): Promise<void> {
  const state = await loadCameraState();
  await saveCameraState({ lastApertures: { ...state.lastApertures, [profileId]: aperture } });
}
