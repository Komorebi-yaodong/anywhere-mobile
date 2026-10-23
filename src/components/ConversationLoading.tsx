import React, {useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, StyleSheet, View} from 'react-native';
import {DesktopBrandMark} from './DesktopBrandMark';
import {useTheme} from './theme';

const size = 44;
const unit = size / 160;

/** One centered brand animation; never a message, overlay or persisted content. */
export function ConversationLoading() {
  const theme = useTheme();
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
        <DesktopBrandMark size={size} bodyColor={theme.colors.primary} faceColor={theme.colors.background} showEyes={false} />
        <Animated.View testID="loading-brand-gaze" pointerEvents="none" style={[StyleSheet.absoluteFill, {transform: [
          {translateX: phase.interpolate({inputRange, outputRange: [0, 1.4, 1.4, 0, -1.4, -1.4, 0]})},
        ]}]}>
          <View testID="loading-brand-eye-left" style={[styles.eye, styles.leftEye, {backgroundColor: theme.colors.background}]} />
          <View testID="loading-brand-eye-right" style={[styles.eye, styles.rightEye, {backgroundColor: theme.colors.background}]} />
        </Animated.View>
      </Animated.View>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  row: {width: '100%', minHeight: 76, paddingVertical: 12, alignItems: 'center', justifyContent: 'center'},
  stage: {width: 96, height: 48, alignItems: 'center', justifyContent: 'center'},
  mark: {width: size, height: size},
  eye: {position: 'absolute', top: 60 * unit, width: 15 * unit, height: 15 * unit},
  leftEye: {left: 45 * unit}, rightEye: {left: 100 * unit},
});
