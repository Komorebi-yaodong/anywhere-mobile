import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {PhotoUploadNotice} from '../src/components/PhotoUploadNotice';
it('status and 100% are not clickable; only explicit cancel invokes cancellation', async () => {
  const cancel = jest.fn(), close = jest.fn();let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<PhotoUploadNotice text="校验照片 100%" active onCancel={cancel} onClose={close} />);});
  const status = root.root.findByProps({accessibilityLabel: '照片上传状态'});
  expect(status.props.onPress).toBeUndefined();
  expect(root.root.findAllByType(Text).find(node => node.props.children === '校验照片 100%')!.props.onPress).toBeUndefined();
  expect(cancel).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '取消照片上传' && node.props.onPress)[0].props.onPress());
  expect(cancel).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();
  await act(async () => root.update(<PhotoUploadNotice text="已取消上传。" active={false} onCancel={cancel} onClose={close} />));
  expect(root.root.findAll(node => node.props.accessibilityLabel === '取消照片上传')).toHaveLength(0);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '关闭照片提示' && node.props.onPress)[0].props.onPress());
  expect(cancel).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
