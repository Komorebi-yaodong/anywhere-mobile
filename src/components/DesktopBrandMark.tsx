import React from 'react';
import Svg, {Rect} from 'react-native-svg';

/**
 * Exact geometric Mobile rendering of Anywhere Desktop's build/icon.svg.
 * The transparent canvas lets each screen provide its own surrounding surface.
 */
export function DesktopBrandMark({size = 32, bodyColor = '#000000', faceColor = '#FFFFFF', showEyes = true}: {
  size?: number; bodyColor?: string; faceColor?: string; showEyes?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 160 160" accessibilityLabel="Anywhere">
      <Rect x="30" y="20" width="20" height="20" fill={bodyColor} />
      <Rect x="110" y="20" width="20" height="20" fill={bodyColor} />
      <Rect x="20" y="40" width="120" height="80" fill={bodyColor} />
      <Rect x="30" y="120" width="16" height="25" fill={bodyColor} />
      <Rect x="54" y="120" width="16" height="25" fill={bodyColor} />
      <Rect x="90" y="120" width="16" height="25" fill={bodyColor} />
      <Rect x="114" y="120" width="16" height="25" fill={bodyColor} />
      {showEyes ? <>
        <Rect x="45" y="60" width="15" height="15" fill={faceColor} />
        <Rect x="100" y="60" width="15" height="15" fill={faceColor} />
      </> : null}
      <Rect x="70" y="85" width="20" height="8" fill={faceColor} />
    </Svg>
  );
}
