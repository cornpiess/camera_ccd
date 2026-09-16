import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import bundledProfileData from '../../assets/camera-profiles.json';
import type { CameraProfile, ProfileDocument } from './types';
import { parseProfileDocument, validateProfileDocument } from './validation';

const OVERRIDE_FILENAME = 'camera-profiles.override.json';

export interface ProfilesContextValue {
  readonly profiles: readonly CameraProfile[];
  readonly currentProfile: CameraProfile | null;
  readonly currentProfileId: string | null;
  readonly document: ProfileDocument | null;
  readonly loading: boolean;
  readonly errors: readonly string[];
  selectProfile: (profileId: string) => boolean;
  importJson: () => Promise<boolean>;
  applyText: (text: string) => Promise<boolean>;
  /**
   * Import EITHER a complete profile document OR a single profile object. A single
   * profile is merged into the active document (replacing the entry with the same id,
   * otherwise appended) — this is the per-camera tuning loop. When `selectId` is given
   * and present after the merge, that camera becomes the active one.
   */
  applyProfileText: (text: string, selectId?: string) => Promise<boolean>;
  /** Single-camera variant of importJson; same dual-shape merge as applyProfileText. */
  importProfileFile: (selectId?: string) => Promise<boolean>;
  /** Pretty-printed JSON of the currently active document, or null when none is loaded. */
  exportJson: () => string | null;
  /** Pretty-printed JSON of one profile, or null when the id is unknown. */
  exportProfileJson: (profileId: string) => string | null;
  /** Restore one profile to its bundled factory values inside the active document. */
  resetProfile: (profileId: string) => Promise<boolean>;
  reload: () => Promise<boolean>;
  reset: () => Promise<boolean>;
  clearErrors: () => void;
}

const ProfilesContext = createContext<ProfilesContextValue | null>(null);

const overrideFile = (): File => new File(Paths.document, OVERRIDE_FILENAME);

function preferredId(document: ProfileDocument): string {
  return document.profiles[0]!.id;
}

function bundledDocument(): ProfileDocument {
  const result = validateProfileDocument(bundledProfileData as unknown);
  if (!result.success) {
    throw new Error(`Bundled camera profiles are invalid:\n${result.errors.join('\n')}`);
  }
  return result.document;
}

/** Parse text as a full document first; fall back to a single-profile merge payload. */
function parseForMerge(text: string): { success: true; shape: 'document' | 'profile'; document: ProfileDocument } | { success: false; errors: readonly string[] } {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    return { success: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).profiles)) {
    const result = parseProfileDocument(trimmed);
    return result.success ? { success: true, shape: 'document', document: result.document } : { success: false, errors: result.errors };
  }
  // Single profile: validate it inside a one-entry document so the error paths and the
  // development-metadata stripping behave exactly like the bundled document path.
  const result = validateProfileDocument({ schemaVersion: 1, profiles: [parsed] });
  if (!result.success) return { success: false, errors: result.errors };
  return { success: true, shape: 'profile', document: result.document };
}

export function ProfileProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [document, setDocument] = useState<ProfileDocument | null>(null);
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<readonly string[]>([]);

  const install = useCallback((next: ProfileDocument): void => {
    setDocument(next);
    setCurrentProfileId((existing) =>
      existing !== null && next.profiles.some((profile) => profile.id === existing)
        ? existing
        : preferredId(next),
    );
  }, []);

  // Per-camera merge: full documents replace everything; a single-profile payload is
  // spliced into the active document so the other cameras keep their tuned values.
  // Pure computation — the caller persists BEFORE installing the result.
  const computeMerge = useCallback((incoming: ProfileDocument, selectId?: string): ProfileDocument => {
    const entry = incoming.profiles[0]!;
    const base = document ?? bundledDocument();
    const replaced = base.profiles.some((profile) => profile.id === entry.id);
    return {
      ...base,
      profiles: replaced
        ? base.profiles.map((profile) => (profile.id === entry.id ? entry : profile))
        : [...base.profiles, entry],
    };
  }, [document]);

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    const loadErrors: string[] = [];
    try {
      const file = overrideFile();
      if (file.exists) {
        const result = parseProfileDocument(await file.text());
        if (result.success) {
          install(result.document);
          setErrors([]);
          return true;
        }
        loadErrors.push('Saved override is invalid; using bundled profiles.', ...result.errors);
      }
      const fallback = bundledDocument();
      install(fallback);
      setErrors(loadErrors);
      return true;
    } catch (error: unknown) {
      // Keep an already-valid state intact on all read/parse failures.
      setErrors([...loadErrors, `Unable to load profiles: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    } finally {
      setLoading(false);
    }
  }, [install]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyText = useCallback(async (text: string): Promise<boolean> => {
    const result = parseProfileDocument(text);
    if (!result.success) {
      setErrors(result.errors);
      return false;
    }
    try {
      // Persist first, so a failed write never replaces the last valid state.
      overrideFile().write(JSON.stringify(result.document, null, 2));
      install(result.document);
      setErrors([]);
      return true;
    } catch (error: unknown) {
      setErrors([`Unable to save profile override: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [install]);

  const applyMerged = useCallback((merged: ProfileDocument, selectId?: string): boolean => {
    try {
      // Persist first, so a failed write never replaces the last valid state.
      overrideFile().write(JSON.stringify(merged, null, 2));
      install(merged);
      if (selectId !== undefined && merged.profiles.some((profile) => profile.id === selectId)) {
        setCurrentProfileId(selectId);
      }
      setErrors([]);
      return true;
    } catch (error: unknown) {
      setErrors([`Unable to save profile override: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [install]);

  const applyProfileText = useCallback(async (text: string, selectId?: string): Promise<boolean> => {
    const result = parseForMerge(text);
    if (!result.success) {
      setErrors(result.errors);
      return false;
    }
    if (result.shape === 'document') {
      const ok = await applyText(JSON.stringify(result.document));
      if (ok && selectId !== undefined) {
        if (result.document.profiles.some((profile) => profile.id === selectId)) setCurrentProfileId(selectId);
      }
      return ok;
    }
    return applyMerged(computeMerge(result.document), selectId);
  }, [applyMerged, applyText, computeMerge]);

  const importProfileFile = useCallback(async (selectId?: string): Promise<boolean> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return false;
      const asset = result.assets[0];
      if (asset === undefined) {
        setErrors(['The selected document could not be read.']);
        return false;
      }
      return applyProfileText(await new File(asset.uri).text(), selectId);
    } catch (error: unknown) {
      setErrors([`Unable to import JSON: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [applyProfileText]);

  const importJson = useCallback(async (): Promise<boolean> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return false;
      const asset = result.assets[0];
      if (asset === undefined) {
        setErrors(['The selected document could not be read.']);
        return false;
      }
      return applyText(await new File(asset.uri).text());
    } catch (error: unknown) {
      setErrors([`Unable to import JSON: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [applyText]);

  const reset = useCallback(async (): Promise<boolean> => {
    try {
      const file = overrideFile();
      if (file.exists) file.delete();
      const fallback = bundledDocument();
      install(fallback);
      setErrors([]);
      return true;
    } catch (error: unknown) {
      setErrors([`Unable to reset profiles: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [install]);

  const selectProfile = useCallback((profileId: string): boolean => {
    if (document?.profiles.some((profile) => profile.id === profileId) !== true) {
      setErrors([`Unknown profile id "${profileId}".`]);
      return false;
    }
    setCurrentProfileId(profileId);
    setErrors([]);
    return true;
  }, [document]);

  const currentProfile = useMemo(
    () => document?.profiles.find((profile) => profile.id === currentProfileId) ?? null,
    [currentProfileId, document],
  );

  const exportJson = useCallback((): string | null => {
    return document ? JSON.stringify(document, null, 2) : null;
  }, [document]);

  const exportProfileJson = useCallback((profileId: string): string | null => {
    const profile = document?.profiles.find((entry) => entry.id === profileId);
    return profile ? JSON.stringify(profile, null, 2) : null;
  }, [document]);

  const resetProfile = useCallback(async (profileId: string): Promise<boolean> => {
    try {
      const factory = bundledDocument().profiles.find((entry) => entry.id === profileId);
      if (factory === undefined) {
        setErrors([`Unknown profile id "${profileId}".`]);
        return false;
      }
      const base = document ?? bundledDocument();
      const merged: ProfileDocument = {
        ...base,
        profiles: base.profiles.map((entry) => (entry.id === profileId ? factory : entry)),
      };
      return applyMerged(merged);
    } catch (error: unknown) {
      setErrors([`Unable to reset profile: ${error instanceof Error ? error.message : String(error)}`]);
      return false;
    }
  }, [applyMerged, document]);

  const value = useMemo<ProfilesContextValue>(() => ({
    profiles: document?.profiles ?? [],
    currentProfile,
    currentProfileId,
    document,
    loading,
    errors,
    selectProfile,
    importJson,
    applyText,
    applyProfileText,
    importProfileFile,
    exportJson,
    exportProfileJson,
    resetProfile,
    reload: load,
    reset,
    clearErrors: () => setErrors([]),
  }), [applyProfileText, applyText, currentProfile, currentProfileId, document, errors, exportJson, exportProfileJson, importJson, importProfileFile, load, loading, reset, resetProfile, selectProfile]);

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesContextValue {
  const value = useContext(ProfilesContext);
  if (value === null) throw new Error('useProfiles must be used within a ProfileProvider');
  return value;
}
