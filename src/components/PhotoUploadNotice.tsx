import React from 'react';
import {Pressable, Text, View, type StyleProp, type ViewStyle, type TextStyle} from 'react-native';

/** Status text is never a destructive action. Cancellation is explicit. */
export function PhotoUploadNotice({text, active, onCancel, onClose, style, textStyle}: {
  text: string; active: boolean; onCancel: () => void; onClose: () => void;
  style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>;
}) {
  if (!text) return null;
  return <View style={style} accessibilityLabel="照片上传状态">
    <Text style={textStyle}>{text}</Text>
    {active ? <Pressable accessibilityRole="button" accessibilityLabel="取消照片上传" onPress={onCancel}><Text style={textStyle}>取消上传</Text></Pressable>
      : <Pressable accessibilityRole="button" accessibilityLabel="关闭照片提示" onPress={onClose}><Text style={textStyle}>关闭</Text></Pressable>}
  </View>;
}
