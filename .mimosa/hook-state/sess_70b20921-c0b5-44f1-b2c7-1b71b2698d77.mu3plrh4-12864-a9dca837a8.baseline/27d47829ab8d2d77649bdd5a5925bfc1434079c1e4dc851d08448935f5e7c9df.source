import React, { useEffect, useRef } from 'react';
import {
  Image,
  TouchableOpacity,
  View,
  StyleSheet,
  Animated,
} from 'react-native';

export interface ThumbnailPreviewProps {
  uri?: string | null;
  size?: number;
  /** When provided and a photo exists, the thumbnail opens the photo library. */
  onPress?: () => void;
}

export const ThumbnailPreview: React.FC<ThumbnailPreviewProps> = ({
  uri,
  size = 48,
  onPress,
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

  const image = (
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
  );

  if (uri && onPress) {
    return (
      <Animated.View style={{ transform: [{ scale: bounceAnim }] }}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open the photo library"
          activeOpacity={0.75}
          onPress={onPress}
        >
          {image}
        </TouchableOpacity>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={{ transform: [{ scale: bounceAnim }] }} pointerEvents="none">
      {image}
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
