import React from 'react';
import {StyleSheet, View} from 'react-native';
import {ActivityIndicator} from './ThemedNative';

/** Request feedback only; never persisted or inserted as a synthetic message. */
export function ConversationLoading() {
  return <View testID="conversation-loading" accessibilityRole="progressbar" accessibilityLabel="正在生成回复" accessibilityState={{busy: true}} pointerEvents="none" style={styles.row}>
    <ActivityIndicator size="small" />
  </View>;
}
const styles = StyleSheet.create({row: {minHeight: 44, paddingVertical: 12, paddingHorizontal: 4, alignItems: 'flex-start', justifyContent: 'center'}});
