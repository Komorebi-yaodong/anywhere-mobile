import {FileSystem} from 'react-native-file-access';
import {parse} from 'react-native-svg';
import {cacheRemoteHttpsResource} from './remoteImageCache';

import {httpsResourceUrl} from './httpsResourceUrl';

export type ModelLogo = {uri: string; version: string; xml?: string};
const pending = new Map<string, Promise<ModelLogo | null>>();

const consumers = new Map<string, Set<AbortSignal | undefined>>();
const recent = new Map<string, {value: ModelLogo | null; until: number}>();
const queue: Array<() => void> = [];
let active = 0;
const maxBytes = 512 * 1024;

/** Same provider|model convention as Desktop; never send provider configuration. */
export function modelNameForLogo(model: string): string {
  const parts = String(model || '').split('|');
  return (parts[1] || parts[0] || '').trim().slice(0, 320);
}


/** Only local vector primitives/references; no scripts, images, CSS imports or external resources. */
export function verifiedLogoSvg(xml: string): string {
  if (!xml || xml.length > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('model_logo_svg_invalid');
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc']);
  let count = 0;
  const ast = parse(xml, root => {
    const walk = (node: typeof root, depth: number) => {
      if (++count > 2048 || depth > 32 || !allowed.has(node.tag)) throw new Error('model_logo_svg_unsupported');
      const check = (key: string, value: unknown) => {
        if (/^on/i.test(key) || key === 'src') throw new Error('model_logo_svg_external');
        if (key === 'style' && value && typeof value === 'object') {Object.entries(value).forEach(([k, v]) => check(k, v)); return;}
        const text = String(value || '');
        if (/href$/i.test(key) && !/^#[A-Za-z_][\w:.-]*$/.test(text)) throw new Error('model_logo_svg_external');
        if (/url\s*\(/i.test(text) && !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(text)) throw new Error('model_logo_svg_external');
        if (/(?:https?:|data:|javascript:|@import)/i.test(text) && key !== 'xmlns' && key !== 'xmlnsXlink') throw new Error('model_logo_svg_external');
      };
      Object.entries(node.props).forEach(([key, value]) => check(key, value));
      node.children.forEach(child => {if (typeof child !== 'string') walk(child, depth + 1);});
    };
    if (root.tag !== 'svg') throw new Error('model_logo_svg_invalid');
    walk(root, 0); return root;
  });
  if (!ast) throw new Error('model_logo_svg_invalid');
  return xml;
}

async function load(name: string): Promise<ModelLogo | null> {
  try {
    const cached = recent.get(name);
    if (cached && cached.until > Date.now()) {
      if (!cached.value) return null;
      const path = cached.value.uri.replace(/^file:\/\//, '');
      if (await FileSystem.exists(path) && (await FileSystem.hash(path, 'SHA-256')).toLowerCase() === cached.value.version) return cached.value;
      recent.delete(name);
    }
    const metadata = await cacheRemoteHttpsResource({url: `https://llm-model.141277.xyz/v1/resolve?model=${encodeURIComponent(name)}`, namespace: 'model-logo', maxBytes: 64 * 1024});
    const payload = JSON.parse(await FileSystem.readFile(metadata.uri.replace(/^file:\/\//, ''), 'utf8'));
    const url = httpsResourceUrl(payload?.resolved?.logo);
    if (!url) return null;
    const image = await cacheRemoteHttpsResource({url, namespace: 'model-logo', maxBytes});
    if (image.mimeType === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(url)) {
      return {uri: image.uri, version: image.version, xml: verifiedLogoSvg(await FileSystem.readFile(image.uri.replace(/^file:\/\//, ''), 'utf8'))};
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) return null;
    return {uri: image.uri, version: image.version};
  } catch {return null;}
}

/** Four requests at most; concurrent buttons share the same resolve/download. */
export function resolveModelLogo(model: string, signal?: AbortSignal): Promise<ModelLogo | null> {
  const name = modelNameForLogo(model);
  if (!name || signal?.aborted) return Promise.resolve(null);
  const existing = pending.get(name);
  if (existing) {consumers.get(name)?.add(signal); return existing;}
  consumers.set(name, new Set([signal]));
  const run = new Promise<ModelLogo | null>(resolve => {
    const start = () => {
      if (![...(consumers.get(name) || [])].some(consumer => !consumer?.aborted)) {
        pending.delete(name); consumers.delete(name); resolve(null); queue.shift()?.(); return;
      }
      active++;
      load(name).then(value => {
        const prior = recent.get(name);
        const until = prior && prior.value === value && prior.until > Date.now() ? prior.until : Date.now() + (value ? 5 * 60_000 : 30_000);
        recent.delete(name);
        recent.set(name, {value, until});
        if (recent.size > 256) recent.delete(recent.keys().next().value!);
        active--; pending.delete(name); consumers.delete(name); queue.shift()?.();
        resolve(value);
      });
    };
    if (active < 4) start(); else queue.push(start);
  });
  pending.set(name, run);
  return run;
}
