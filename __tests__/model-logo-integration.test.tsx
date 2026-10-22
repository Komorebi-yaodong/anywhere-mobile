import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {FileSystem} from 'react-native-file-access';
import {SvgXml} from 'react-native-svg';
import {ModelLogo} from '../src/components/ModelLogo';
import {AppIcon} from '../src/components/AppIcon';
import {openaiLogo, geminiLogo} from '../test-fixtures/modelLogos';

const {URL: NativeURL} = jest.requireActual('react-native/Libraries/Blob/URL');
const standardURL = globalThis.URL;
const {createHash} = require('node:crypto');

const {Buffer} = require('node:buffer');
const files = new Map<string, string>();
const requests: Array<{url: string; method: string}> = [];
const assets = [openaiLogo, geminiLogo];

beforeEach(() => {
  globalThis.URL = NativeURL;
  files.clear(); requests.length = 0; jest.clearAllMocks();
  (FileSystem.exists as jest.Mock).mockImplementation(async path => path === '/cache/anywhere-https-resources' || files.has(path));
  (FileSystem.mkdir as jest.Mock).mockResolvedValue(undefined);
  (FileSystem.readFile as jest.Mock).mockImplementation(async path => {if (!files.has(path)) throw new Error('missing'); return files.get(path);});
  (FileSystem.writeFile as jest.Mock).mockImplementation(async (path, body) => {files.set(path, body);});
  (FileSystem.stat as jest.Mock).mockImplementation(async path => {if (!files.has(path)) throw new Error('missing'); return {size: Buffer.byteLength(files.get(path)!), type: 'file'};});
  (FileSystem.hash as jest.Mock).mockImplementation(async path => createHash('sha256').update(files.get(path)!).digest('hex'));
  (FileSystem.mv as jest.Mock).mockImplementation(async (from, to) => {files.set(to, files.get(from)!); files.delete(from);});
  (FileSystem.unlink as jest.Mock).mockImplementation(async path => {files.delete(path);});
  (FileSystem.fetchManaged as jest.Mock).mockImplementation((url, init) => ({cancel: jest.fn(), result: (async () => {
    requests.push({url, method: init.method || 'GET'});
    const metadata = url.startsWith('https://llm-model.141277.xyz/v1/resolve?model=');
    const asset = metadata ? (url.endsWith('gemini-2.5-pro') ? geminiLogo : openaiLogo) : assets.find(item => item.url === url);
    if (!asset) throw new Error('unexpected fixture URL');
    if (init.path) files.set(init.path, metadata ? JSON.stringify({resolved: {logo: asset.url}}) : asset.xml);
    return {ok: true, status: 200, url, getHeader: (key: string) => key === 'content-type' ? (metadata ? 'application/json; charset=utf-8' : 'image/svg+xml') : ''};
  })()}));
});
afterEach(() => {globalThis.URL = standardURL;});

it.each([['gpt-4o', openaiLogo], ['gemini-2.5-pro', geminiLogo]] as const)('renders the real %s SVG through the entire cache pipeline using the native RN URL implementation', async (name, asset) => {
  // RN 0.86's URL.username incorrectly scans beyond the authority into @scope paths.
  expect(new NativeURL(asset.url).username).not.toBe('');
  let root!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {root = TestRenderer.create(<ModelLogo model={`private-provider|${name}`} />);});
    expect(requests).toEqual([
      {url: `https://llm-model.141277.xyz/v1/resolve?model=${name}`, method: 'GET'},
      {url: asset.url, method: 'GET'},
    ]);
    expect(root.root.findByType(SvgXml).props.xml).toBe(asset.xml);
    expect(root.root.findAllByType(AppIcon)).toHaveLength(0);
    expect([...files.values()]).toContain(asset.xml);
    expect(JSON.stringify(requests)).not.toContain('private-provider');
  } finally {await act(async () => root?.unmount());}
});
