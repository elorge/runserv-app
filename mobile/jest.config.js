// mobile/jest.config.js
// Reproducible from package.json: `jest` and `jest-expo` are declared in devDependencies (launch-readiness guide §7.1).
// The current suites are pure-logic (no components), so no extra setup file is required. If component tests are added later,
// add @testing-library/react-native to devDependencies and a setupFilesAfterEnv entry here.
module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@maplibre/.*|react-native-svg))',
  ],
};
