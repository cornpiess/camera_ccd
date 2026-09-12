import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraProfile } from '../profiles/types';
import type { Point } from './types';
import { profileDisplayName } from './types';
import { GlassCard } from './GlassCard';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Radial menu geometry
export const ITEM_RADIUS = 115;
export const ITEM_SIZE = 52;
export const CENTER_CANCEL_RADIUS = 38;
export const MENU_PADDING = 75;
export const TOP_CONTROLS_SAFE = 80;
export const BOTTOM_CONTROLS_SAFE = 150;
/** Hard cap of nodes on the radial ring (geometry stays legible up to here). */
export const MAX_RING_PROFILES = 12;

/**
 * Compute clamped center ensuring all ring nodes stay within safe screen bounds
 */
export function getClampedCenter(
  initialTouch: Point,
  screenWidth: number = SCREEN_WIDTH,
  screenHeight: number = SCREEN_HEIGHT
): Point {
  const minX = MENU_PADDING;
  const maxX = screenWidth - MENU_PADDING;
  const minY = TOP_CONTROLS_SAFE + MENU_PADDING;
  const maxY = screenHeight - BOTTOM_CONTROLS_SAFE - MENU_PADDING;

  const clampedX = Math.max(minX, Math.min(initialTouch.x, maxX));
  const clampedY = Math.max(minY, Math.min(initialTouch.y, maxY));

  return { x: clampedX, y: clampedY };
}

/**
 * Determine sector index from touch position relative to clamped center
 */
export function computeRadialSector(
  pageX: number,
  pageY: number,
  center: Point,
  profileCount: number
): number | null {
  if (profileCount < 1) return null;
  const dx = pageX - center.x;
  const dy = pageY - center.y;
  const distance = Math.hypot(dx, dy);

  // Center cancel zone
  if (distance < CENTER_CANCEL_RADIUS) {
    return null;
  }

  // Sectors of 360/profileCount degrees, with index 0 centered at top (-PI / 2)
  const angle = Math.atan2(dy, dx);
  const sectorStep = (2 * Math.PI) / profileCount;
  let shifted = angle + Math.PI / 2 + sectorStep / 2;
  shifted = ((shifted % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  const index = Math.floor(shifted / sectorStep) % profileCount;
  return index < profileCount ? index : null;
}

export interface RadialProfileSelectorProps {
  readonly visible: boolean;
  readonly initialTouch: Point;
  readonly currentTouch?: Point | null;
  readonly profiles: readonly CameraProfile[];
  readonly activeProfileId?: string;
  readonly onSelectProfile?: (profile: CameraProfile) => void;
  readonly onCancel?: () => void;
}

export const RadialProfileSelector: React.FC<RadialProfileSelectorProps> = ({
  visible,
  initialTouch,
  currentTouch,
  profiles,
  activeProfileId,
}: RadialProfileSelectorProps) => {
  // Ring geometry adapts to the profile count (9 nodes sit slightly farther out
  // so adjacent glass cards and their labels keep clear separation).
  const displayProfiles = useMemo(() => profiles.slice(0, MAX_RING_PROFILES), [profiles]);
  const itemRadius = displayProfiles.length > 8 ? ITEM_RADIUS + 9 : ITEM_RADIUS;
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const lastHapticIndexRef = useRef<number | null>(null);

  // Animation drivers
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  // Clamped center point ensuring all 8 nodes stay within safe screen bounds
  const clampedCenter = useMemo<Point>(() => {
    return getClampedCenter(initialTouch);
  }, [initialTouch]);

  // Entrance & Exit animations
  useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      lastHapticIndexRef.current = null;
      setHighlightedIndex(null);

      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 180,
          friction: 12,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 0.8,
          duration: 120,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, scaleAnim, opacityAnim]);

  /**
   * Determine sector index from touch position relative to clamped center
   */
  const computeSector = useCallback(
    (pageX: number, pageY: number): number | null => {
      return computeRadialSector(pageX, pageY, clampedCenter, displayProfiles.length);
    },
    [clampedCenter, displayProfiles.length]
  );

  /**
   * Handle sliding touches with haptic response on sector change
   */
  const handleTouchMove = useCallback(
    (pageX: number, pageY: number) => {
      const sector = computeSector(pageX, pageY);

      if (sector !== lastHapticIndexRef.current) {
        lastHapticIndexRef.current = sector;
        setHighlightedIndex(sector);

        if (sector !== null) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        } else {
          Haptics.selectionAsync().catch(() => {});
        }
      }
    },
    [computeSector]
  );

  /**
   * Track external continuous sliding touch while pressed
   */
  useEffect(() => {
    if (visible && currentTouch) {
      handleTouchMove(currentTouch.x, currentTouch.y);
    }
  }, [visible, currentTouch, handleTouchMove]);

  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {/* Dimmed backdrop */}
      <Animated.View
        style={[styles.backdrop, { opacity: opacityAnim }]}
      >
        {/* Radial Cluster centered at clamped coordinate */}
        <Animated.View
          style={[
            styles.radialCluster,
            {
              left: clampedCenter.x,
              top: clampedCenter.y,
              transform: [{ scale: scaleAnim }],
            },
          ]}
        >
          {/* Outer ring guide */}
          <View style={styles.outerRingGuide} />

          {/* Center Cancel Node */}
          <View
            style={[
              styles.centerCancelNode,
              highlightedIndex === null && styles.centerCancelActive,
            ]}
          >
            <Text
              style={[
                styles.centerCancelText,
                highlightedIndex === null && styles.centerCancelTextActive,
              ]}
            >
              ✕
            </Text>
          </View>

          {/* Radial Profile Nodes (one per profile, capped at MAX_RING_PROFILES) */}
          {displayProfiles.map((profile: CameraProfile, i: number) => {
            const sectorAngle = -Math.PI / 2 + i * ((2 * Math.PI) / displayProfiles.length);
            const posX = Math.cos(sectorAngle) * itemRadius;
            const posY = Math.sin(sectorAngle) * itemRadius;

            const isHighlighted = highlightedIndex === i;
            const isCurrentlyActive = profile.id === activeProfileId;
            const accent = profile.ui?.accent || '#FFFFFF';
            const shortName = profile.ui?.shortName || profileDisplayName(profile).slice(0, 4).toUpperCase();
            const displayNameLabel = profileDisplayName(profile);

            return (
              <View
                key={profile.id}
                style={[
                  styles.nodeWrapper,
                  {
                    transform: [
                      { translateX: posX - ITEM_SIZE / 2 },
                      { translateY: posY - ITEM_SIZE / 2 },
                      { scale: isHighlighted ? 1.22 : 1 },
                    ],
                  },
                ]}
              >
                <GlassCard
                  borderRadius={ITEM_SIZE / 2}
                  style={styles.nodeGlass}
                >
                  <View
                    style={[
                      styles.nodeInner,
                      isCurrentlyActive && styles.nodeInnerActiveBorder,
                      isHighlighted && styles.nodeInnerHighlighted,
                    ]}
                  >
                    <Text
                      style={[
                        styles.nodeShortText,
                        isHighlighted && styles.nodeShortTextHighlighted,
                        { color: isHighlighted ? accent : '#E0E0E0' },
                      ]}
                    >
                      {shortName}
                    </Text>
                  </View>
                </GlassCard>

                {/* Profile label */}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.nodeLabel,
                    isHighlighted && styles.nodeLabelHighlighted,
                  ]}
                >
                  {displayNameLabel}
                </Text>
              </View>
            );
          })}
        </Animated.View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  radialCluster: {
    position: 'absolute',
    width: 0,
    height: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outerRingGuide: {
    position: 'absolute',
    width: ITEM_RADIUS * 2,
    height: ITEM_RADIUS * 2,
    borderRadius: ITEM_RADIUS,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderStyle: 'dashed',
    transform: [{ translateX: -ITEM_RADIUS }, { translateY: -ITEM_RADIUS }],
  },
  centerCancelNode: {
    position: 'absolute',
    width: CENTER_CANCEL_RADIUS * 2,
    height: CENTER_CANCEL_RADIUS * 2,
    borderRadius: CENTER_CANCEL_RADIUS,
    backgroundColor: 'rgba(20, 20, 20, 0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    transform: [
      { translateX: -CENTER_CANCEL_RADIUS },
      { translateY: -CENTER_CANCEL_RADIUS },
    ],
  },
  centerCancelActive: {
    backgroundColor: 'rgba(220, 50, 50, 0.75)',
    borderColor: '#FF4444',
    transform: [
      { translateX: -CENTER_CANCEL_RADIUS },
      { translateY: -CENTER_CANCEL_RADIUS },
      { scale: 1.15 },
    ],
  },
  centerCancelText: {
    color: '#888888',
    fontSize: 18,
    fontWeight: '600',
  },
  centerCancelTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  nodeWrapper: {
    position: 'absolute',
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeGlass: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 4,
  },
  nodeInner: {
    flex: 1,
    borderRadius: ITEM_SIZE / 2,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeInnerActiveBorder: {
    borderColor: '#007AFF',
    borderWidth: 2,
  },
  nodeInnerHighlighted: {
    borderWidth: 2.5,
  },
  nodeShortText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  nodeShortTextHighlighted: {
    fontSize: 15,
    fontWeight: '900',
  },
  nodeLabel: {
    position: 'absolute',
    bottom: -18,
    width: 90,
    textAlign: 'center',
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 9,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  nodeLabelHighlighted: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 10,
  },
});

