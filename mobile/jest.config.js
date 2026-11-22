// mobile/jest.config.js
// Reproducible from package.json: `jest` and `jest-expo` are declared in devDependencies (launch-readiness guide §7.1).
// Suites are pure-logic (no components). jest.setup.js provides the AsyncStorage mock for modules that import services/api.js.
// If component tests are added later, add @testing-library/react-native to devDependencies and a setupFilesAfterEnv entry here.
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@maplibre/.*|react-native-svg))',
  ],
};
