import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert} from 'react-native';
import {Camera, useCameraFormat} from 'react-native-vision-camera';
import {PhotoCapture} from '../src/components/PhotoCapture';
const mockTakePhoto = jest.fn(); const mockFocus = jest.fn();
jest.mock('react-native-vision-camera', () => {
 const R = require('react'); const {View} = require('react-native');
 return {Camera: R.forwardRef((props: any, ref: any) => {R.useImperativeHandle(ref, () => ({takePhoto: mockTakePhoto, focus: mockFocus})); return R.createElement(View, props);}), useCameraDevice: () => ({id: 'back', supportsFocus: true, hasFlash: true}), useCameraFormat: jest.fn(() => ({photoWidth: 4032, photoHeight: 3024})), useCameraPermission: () => ({hasPermission: true, requestPermission: jest.fn()})};
});
beforeEach(() => {jest.clearAllMocks(); mockFocus.mockResolvedValue(undefined); mockTakePhoto.mockResolvedValue({path: '/temporary/full-resolution.jpg'});});
it('selects max photo resolution and quality priority without a dimming overlay or a zoom-blocking touch layer', async () => {
 let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<PhotoCapture onCancel={jest.fn()} onCaptured={jest.fn()} />);});
 expect(useCameraFormat).toHaveBeenCalledWith(expect.any(Object), [{photoResolution: 'max'}, {videoResolution: {width: 1920, height: 1080}}]);
 expect(root.root.findByType(Camera).props).toMatchObject({photo: true, photoQualityBalance: 'quality', enableZoomGesture: true});
 expect(root.root.findAll(node => node.props.accessibilityLabel === '相机取景区域，轻点对焦' && node.props.onPress)).toHaveLength(0);
 expect(JSON.stringify(root.toJSON())).not.toContain('rgba(0,0,0,0.12)');
 const shutter = root.root.findAll(node => node.props.accessibilityLabel === '拍照' && node.props.onPress)[0]; expect(shutter.props.disabled).toBe(true);
 await act(async () => root.unmount());
});
it('waits for tap focus and prevents double capture before handing the original photo path to upload', async () => {
 const captured = jest.fn(); let finishFocus!: () => void; let finishPhoto!: (photo: {path: string}) => void;
 mockFocus.mockImplementation(() => new Promise<void>(yes => {finishFocus = yes;})); mockTakePhoto.mockImplementation(() => new Promise(yes => {finishPhoto = yes;}));
 let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<PhotoCapture onCancel={jest.fn()} onCaptured={captured} />);});
 const camera = () => root.root.findByType(Camera);
 await act(async () => camera().props.onInitialized());
 await act(async () => {camera().props.onTouchStart({nativeEvent: {touches: [{}], locationX: 72, locationY: 105}}); camera().props.onTouchEnd();});
 expect(mockFocus).toHaveBeenCalledWith({x: 72, y: 105});
 const shutter = root.root.findAll(node => node.props.accessibilityLabel === '拍照' && node.props.onPress)[0];
 let first!: Promise<void>; await act(async () => {first = shutter.props.onPress(); shutter.props.onPress();});
 expect(mockTakePhoto).not.toHaveBeenCalled();
 await act(async () => finishFocus()); expect(mockTakePhoto).toHaveBeenCalledTimes(1); expect(mockTakePhoto).toHaveBeenCalledWith({flash: 'auto'});
 await act(async () => {finishPhoto({path: '/temporary/original.jpg'}); await first;}); expect(captured).toHaveBeenCalledWith('/temporary/original.jpg');
 await act(async () => {camera().props.onTouchStart({nativeEvent: {touches: [{}, {}], locationX: 10, locationY: 10}}); camera().props.onTouchEnd();});
 expect(mockFocus).toHaveBeenCalledTimes(1);
 await act(async () => root.unmount());
});
it('surfaces a capture failure instead of leaving the shutter locked', async () => {
 const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined); mockTakePhoto.mockRejectedValue(new Error('camera'));
 let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<PhotoCapture onCancel={jest.fn()} onCaptured={jest.fn()} />);});
 await act(async () => root.root.findByType(Camera).props.onInitialized());
 await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '拍照' && node.props.onPress)[0].props.onPress());
 expect(alert).toHaveBeenCalled(); expect(root.root.findAll(node => node.props.accessibilityLabel === '拍照' && node.props.onPress)[0].props.disabled).toBe(false);
 await act(async () => root.unmount()); alert.mockRestore();
});
