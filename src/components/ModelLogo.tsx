import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {SvgXml} from 'react-native-svg';
import {resolveModelLogo, type ModelLogo as Logo} from '../services/modelLogo';
import {AppIcon} from './AppIcon';

import {useTheme} from './theme';

/** Fixed footprint: loading/missing/broken images never move adjacent composer controls. */
export function ModelLogo({model, enabled = true}: {model: string; enabled?: boolean}) {

  const theme = useTheme();
  const [loaded, setLoaded] = useState<{model: string; logo: Logo | null} | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    if (enabled) resolveModelLogo(model, controller.signal).then(logo => {if (current) {setLoaded({model, logo}); setFailed('');}});
    return () => {current = false; controller.abort();};
  }, [enabled, model]);
  const logo = enabled && loaded?.model === model ? loaded.logo : null;
  const fallback = <AppIcon name="模型" size={21} />;
  return <View testID="model-logo-slot" pointerEvents="none" accessible={false} style={styles.slot}>
    {logo && failed !== logo.uri ? logo.xml
      ? <SvgXml xml={logo.xml} width={21} height={21} color={theme.colors.text} preserveAspectRatio="xMidYMid meet" fallback={fallback} onError={() => undefined} />
      : <Image testID="model-logo-image" source={{uri: logo.uri}} resizeMode="contain" style={styles.image} onError={() => setFailed(logo.uri)} />
      : fallback}
  </View>;
}
const styles = StyleSheet.create({
  slot: {width: 21, height: 21, flexGrow: 0, flexShrink: 0, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  image: {width: 21, height: 21},
});
