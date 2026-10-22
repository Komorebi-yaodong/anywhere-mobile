import {httpsResourceUrl} from '../src/services/httpsResourceUrl';
const {URL: NativeURL} = jest.requireActual('react-native/Libraries/Blob/URL');
const standardURL = globalThis.URL;
afterEach(() => {globalThis.URL = standardURL;});
it.each([['standard', standardURL], ['native React Native', NativeURL]] as const)('validates only the authority with %s URL, not @ in the path/query/fragment', (_name, implementation) => {
  globalThis.URL = implementation;
  for (const path of ['/npm/@lobehub/icons-static-svg@1.91.0/icons/openai.svg', '/file.png?email=user@example.test', '/file.svg#user@name']) {
    const source = `https://cdn.jsdelivr.net${path}`;
    expect(httpsResourceUrl(source)).toBe(source);
  }
  for (const source of ['https://user@host.test/a', 'https://user:password@host.test/a', 'https://evil.test@host.test/a', 'https://%75ser%40host.test/a', 'http://host.test/a', 'file:///cache/a', '//host.test/a', 'https:///a', 'https://host.test\\@evil.test/a', 'https://host.test/\n@evil.test/a']) expect(httpsResourceUrl(source)).toBe('');
});
