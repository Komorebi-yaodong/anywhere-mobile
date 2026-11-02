module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [{
    files: ['scripts/android-release.cjs', 'scripts/desktop-interop.cjs', 'scripts/native-upload-probe.cjs', 'scripts/pairing-fallback-interop.cjs', 'scripts/native-session-probe.cjs', 'scripts/native-image-probe.cjs'],
    env: {node: true, es2022: true},
    parserOptions: {ecmaVersion: 2022, sourceType: 'script'},
    globals: {fetch: 'readonly'},
  }],
};
