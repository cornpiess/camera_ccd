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

