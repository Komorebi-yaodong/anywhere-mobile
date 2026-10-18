/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('../src/hooks/useDesktops', () => ({
  useDesktops: () => ({
    desktops: [],
    pair: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    request: jest.fn(async () => ({})),
    requestTracked: jest.fn(() => ({requestId: 'request-app-fixture-0001', response: Promise.resolve({})})),
    subscribeEvents: jest.fn(() => () => undefined),
  }),
}));

test('renders correctly', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(async () => {
    renderer?.unmount();
  });
});
