import React, { useEffect, useRef } from 'react';
import {
  Image,
  View,
  StyleSheet,
  Animated,
} from 'react-native';

export interface ThumbnailPreviewProps {
  uri?: string | null;
  size?: number;
}

export const ThumbnailPreview: React.FC<ThumbnailPreviewProps> = ({
  uri,
  size = 48,
}: ThumbnailPreviewProps) => {
  const bounceAnim = useRef(new Animated.Value(1)).current;

  // Pop-in bounce animation whenever a new thumbnail arrives
  useEffect(() => {
    if (uri) {
      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: 1.25,
          duration: 120,
          useNativeDriver: true,
        }),
        Animated.spring(bounceAnim, {
          toValue: 1,
          friction: 6,
          tension: 100,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [uri, bounceAnim]);

  return (
    <Animated.View style={{ transform: [{ scale: bounceAnim }] }} pointerEvents="none">
      <View
        style={[
          styles.container,
          { width: size, height: size, borderRadius: size * 0.22 },
        ]}
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={[
              styles.image,
              { width: size, height: size, borderRadius: size * 0.22 },
            ]}
          />
        ) : (
          <View
            style={[
              styles.placeholder,
              { width: size, height: size, borderRadius: size * 0.22 },
            ]}
          >
            {/* Minimalist gallery placeholder icon */}
            <View style={styles.placeholderIconOuter}>
              <View style={styles.placeholderIconInner} />
            </View>
          </View>
        )}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.7)',
    overflow: 'hidden',
    backgroundColor: 'rgba(20, 20, 24, 0.6)',
  },
  image: {
    resizeMode: 'cover',
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 35, 0.7)',
  },
  placeholderIconOuter: {
    width: 22,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderIconInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
});
