/* eslint-env jest */


jest.mock('@react-native-clipboard/clipboard', () => ({__esModule:true,default:{setString:jest.fn(),getString:jest.fn(async()=> '')}}));
jest.mock('react-native-image-picker', () => ({launchImageLibrary:jest.fn(async()=>({didCancel:true}))}));
jest.mock('react-native-file-access', () => ({
  Dirs: {CacheDir: '/cache'},
  FileSystem: {
    exists: jest.fn(async () => false),
    ls: jest.fn(async () => []),
    mkdir: jest.fn(async () => '/cache/anywhere-profile-avatars'),
    writeFile: jest.fn(async () => undefined),
    appendFile: jest.fn(async () => undefined),
    readFile: jest.fn(async () => ''),
    stat: jest.fn(async () => ({size: 1, type: 'file', lastModified: Date.now()})),
    hash: jest.fn(async () => 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
    mv: jest.fn(async () => undefined),
    cpExternal: jest.fn(async () => undefined),
    fetch: jest.fn(async () => ({ok: true, status: 200})),
    unlink: jest.fn(async () => undefined),
  },
}));
jest.mock('react-native-video', () => {
  const React = require('react'); const {View} = require('react-native');
  return {__esModule: true, default: props => React.createElement(View, props)};
});
jest.mock('react-native-latex-text', () => {
  const React = require('react'); const {Text, View} = require('react-native');
  return {
    MathJaxRenderer: props => React.createElement(View, props),
    MathText: ({content, ...props}) => React.createElement(Text, props, content),
    MathRenderer: {Init: jest.fn(), Render: jest.fn(), ClearCache: jest.fn()},
    RenderResult: undefined,
  };
});

jest.mock('lucide-react-native', () => {
  const React=require('react'); const {View}=require('react-native');
  return new Proxy({}, {get: (_target,key) => key==='__esModule'?true:(props)=>React.createElement(View,props)});
});

const {NativeModules} = require('react-native');
NativeModules.PinnedGateway = {
  postJson: jest.fn(async () => ({status: 200, body: '{}'})),
  connectSocket: jest.fn(async () => undefined),
  sendText: jest.fn(async () => undefined),
  disconnect: jest.fn(async () => undefined),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

jest.mock('react-native-vision-camera', () => {
  const React = require('react');
  const {View} = require('react-native');

  return {
    Camera: props => React.createElement(View, props),
    useCameraDevice: () => undefined,
    useCameraPermission: () => ({hasPermission: false, requestPermission: jest.fn()}),
    useCodeScanner: options => options,
  };
});
