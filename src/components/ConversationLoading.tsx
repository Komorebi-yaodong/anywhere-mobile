import React, {useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, Image, StyleSheet, View} from 'react-native';

const size = 44;
// Coordinates match the actual 192px rounded launcher PNG, not the legacy SVG.
const unit = size / 192;

/** One centered brand animation; never a message, overlay or persisted content. */
export function ConversationLoading() {
  const phase = useRef(new Animated.Value(0)).current;
  // Stay still until the system preference is known, avoiding a motion flash.
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let active = true;
    let changed = false;
    AccessibilityInfo.isReduceMotionEnabled().then(value => {if (active && !changed) setReduceMotion(value);}).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      changed = true;
      if (active) setReduceMotion(value);
    });
    return () => {active = false; subscription.remove();};
  }, []);
  useEffect(() => {
    phase.setValue(0);
    if (reduceMotion) return;
    const animation = Animated.loop(Animated.timing(phase, {
      toValue: 1, duration: 3200, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    }));
    animation.start();
    return () => {animation.stop(); phase.stopAnimation();};
  }, [phase, reduceMotion]);
  const inputRange = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1];
  return <View testID="conversation-loading" accessibilityRole="progressbar" accessibilityLabel="正在生成回复" accessibilityState={{busy: true}} pointerEvents="none" style={styles.row}>
    <View style={styles.stage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View testID="loading-brand-motion" style={[styles.mark, {transform: [
        {translateX: phase.interpolate({inputRange, outputRange: [0, 5, 7, 0, -7, -5, 0]})},
        {translateY: phase.interpolate({inputRange, outputRange: [0, -1, 0, 1, 0, -1, 0]})},
      ]}]}>
        <Image testID="loading-brand-image" accessible={false} source={require('../../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')} style={styles.image} resizeMode="contain" fadeDuration={0} />
        <View testID="loading-brand-eye-mask-left" style={[styles.eyeMask, styles.leftEyeMask]} />
        <View testID="loading-brand-eye-mask-right" style={[styles.eyeMask, styles.rightEyeMask]} />
        <Animated.View testID="loading-brand-gaze" pointerEvents="none" style={[StyleSheet.absoluteFill, {transform: [
          {translateX: phase.interpolate({inputRange, outputRange: [0, 1.4, 1.4, 0, -1.4, -1.4, 0]})},
        ]}]}>
          <View testID="loading-brand-eye-left" style={[styles.eye, styles.leftEye]} />
          <View testID="loading-brand-eye-right" style={[styles.eye, styles.rightEye]} />
        </Animated.View>
      </Animated.View>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  row: {width: '100%', minHeight: 76, paddingVertical: 12, alignItems: 'center', justifyContent: 'center'},
  stage: {width: 96, height: 48, alignItems: 'center', justifyContent: 'center'},
  mark: {width: size, height: size},
  image: {width: size, height: size},
  // Cover the PNG's static eyes (including antialiased edges) beneath the moving pair.
  eyeMask: {position: 'absolute', top: 73 * unit, width: 22 * unit, height: 27 * unit, backgroundColor: '#000000'},
  leftEyeMask: {left: 49 * unit}, rightEyeMask: {left: 121 * unit},
  eye: {position: 'absolute', top: 75 * unit, width: 18 * unit, height: 23 * unit, borderRadius: 4 * unit, backgroundColor: '#FFFFFF'},
  leftEye: {left: 51 * unit}, rightEye: {left: 123 * unit},
});
