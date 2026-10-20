import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Keyboard, StyleSheet, View, useWindowDimensions, type KeyboardEvent} from 'react-native';

/** Both rectangles must be in window/screen coordinates, never parent-local Y. */
export function keyboardOverlap(top: number, height: number, keyboardTop?: number): number {
  if (keyboardTop == null || ![top, height, keyboardTop].every(Number.isFinite)) return 0;
  return Math.max(0, Math.min(height, top + height - keyboardTop));
}

/**
 * Avoid only the part of the keyboard actually covering this view. Android
 * adjustResize may already have shortened it; in that case the inset is zero.
 * Measuring the outer view (not its padded children) avoids a layout feedback loop.
 */
export function KeyboardDock({children}: {children: React.ReactNode}) {
  const host = useRef<View>(null);
  const keyboardTop = useRef<number | undefined>(undefined);
  const measurement = useRef(0);
  const [inset, setInset] = useState(0);
  const {width, height} = useWindowDimensions();
  const measure = useCallback(() => {
    const version = ++measurement.current;
    if (keyboardTop.current == null) { setInset(0); return; }
    host.current?.measureInWindow((_x, y, _width, viewHeight) => {
      if (version !== measurement.current) return;
      setInset(keyboardOverlap(y, viewHeight, keyboardTop.current));
    });
  }, []);
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      keyboardTop.current = event.endCoordinates.screenY;
      measure();
    };
    const hide = () => {
      keyboardTop.current = undefined;
      measurement.current += 1;
      setInset(0);
    };
    const shown = Keyboard.addListener('keyboardDidShow', show);
    const changed = Keyboard.addListener('keyboardDidChangeFrame', show);
    const hidden = Keyboard.addListener('keyboardDidHide', hide);
    const current = Keyboard.metrics();
    if (current) { keyboardTop.current = current.screenY; measure(); }
    return () => {
      measurement.current += 1;
      shown.remove(); changed.remove(); hidden.remove();
    };
  }, [measure]);
  useEffect(() => { measure(); }, [measure, width, height]);
  return <View ref={host} collapsable={false} accessibilityLabel="聊天键盘避让区域" onLayout={measure} style={[styles.root, {paddingBottom: inset}]}><View style={styles.root}>{children}</View></View>;
}

const styles = StyleSheet.create({root: {flex: 1, minHeight: 0}});
