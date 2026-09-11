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
  /** Pretty-printed JSON of the currently active document, or null when none is loaded. */
  exportJson: () => string | null;
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
    exportJson,
    reload: load,
    reset,
    clearErrors: () => setErrors([]),
  }), [applyText, currentProfile, currentProfileId, document, errors, exportJson, importJson, load, loading, reset, selectProfile]);

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesContextValue {
  const value = useContext(ProfilesContext);
  if (value === null) throw new Error('useProfiles must be used within a ProfileProvider');
  return value;
}
