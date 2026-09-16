import type { CameraProfile } from '../profiles/types';

/**
 * Unified camera profile derived exclusively from useProfiles JSON state
 */
export type Profile = CameraProfile;
export type { CameraProfile };

/**
 * Point in 2D coordinate space for gesture tracking
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Minimal camera hardware info
 */
export interface CameraInfo {
  id: string;
  name: string;
  isVariableAperture: boolean;
  currentAperture: number;
  availableApertures: number[];
  position: 'back';
}


/**
 * Abstract selection-marker glyphs (GOAL: no real-camera product imagery, no logos —
 * each camera item is an abstract shape + its own name).
 */
export const MARKER_GLYPHS: Record<string, string> = {
  dot: '●',
  line: '▬',
  diamond: '◇',
  ring: '○',
};

export function markerGlyph(style?: string): string {
  return (style && MARKER_GLYPHS[style]) || '●';
}

/** Production display name of a profile (displayName falls back to name). */
export function profileDisplayName(profile: { readonly displayName?: string; readonly name: string }): string {
  return profile.displayName ?? profile.name;
}
