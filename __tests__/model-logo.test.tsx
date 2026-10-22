import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Image, StyleSheet, View} from 'react-native';
import {SvgXml} from 'react-native-svg';
import {ModelLogo} from '../src/components/ModelLogo';
import {AppIcon} from '../src/components/AppIcon';
import {resolveModelLogo} from '../src/services/modelLogo';
jest.mock('../src/services/modelLogo', () => ({resolveModelLogo: jest.fn()}));
const resolve = resolveModelLogo as jest.Mock;
beforeEach(() => {jest.clearAllMocks(); resolve.mockResolvedValue(null);});
it('keeps a 21dp slot and default robot while missing or failed; renders cached raster at the same size', async () => {
 resolve.mockResolvedValue({uri: 'file:///cache/icon.png', version: 'v1'}); let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ModelLogo model="p|model" />);});
 expect(StyleSheet.flatten(root.root.findByType(View).props.style)).toMatchObject({width: 21, height: 21, flexShrink: 0});
 expect(StyleSheet.flatten(root.root.findByType(Image).props.style)).toMatchObject({width: 21, height: 21});
 await act(async () => root.root.findByType(Image).props.onError());
 expect(root.root.findAllByType(Image)).toHaveLength(0); expect(root.root.findByType(AppIcon).props).toMatchObject({name: '模型', size: 21});
 await act(async () => root.unmount());
});
it('renders cached SVG locally and does not request icons from a hidden model picker', async () => {
 resolve.mockResolvedValue({uri: 'file:///cache/icon.svg', version: 'v1', xml: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>'});
 let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<ModelLogo model="p|svg" enabled={false} />);});
 expect(resolve).not.toHaveBeenCalled();
 await act(async () => root.update(<ModelLogo model="p|svg" />));
 expect(root.root.findByType(SvgXml).props).toMatchObject({width: 21, height: 21});
 await act(async () => root.unmount());
});
it('never shows the previous model after model switches or an old request finishes late', async () => {
 let old!: (value: unknown) => void; resolve.mockImplementationOnce(() => new Promise(yes => {old = yes;})).mockResolvedValue({uri: 'file:///cache/new.png', version: 'v2'});
 let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<ModelLogo model="old" />);});
 await act(async () => root.update(<ModelLogo model="new" />));
 await act(async () => old({uri: 'file:///cache/old.png', version: 'v1'}));
 expect(root.root.findByType(Image).props.source.uri).toBe('file:///cache/new.png');
 await act(async () => root.unmount());
});
