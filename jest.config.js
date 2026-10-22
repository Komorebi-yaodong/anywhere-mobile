module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/packages/remote-contract-v1/'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/)?(?:@react-native|react-native|@noble|base64-js))',
  ],
};
