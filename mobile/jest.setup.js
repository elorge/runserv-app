// Jest has no native modules. AsyncStorage (imported by services/api.js and most services) needs its official in-memory mock.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
