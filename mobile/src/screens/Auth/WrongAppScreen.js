// Shown when someone signs in to the wrong one of the two Runserv apps (a rider in the Driver app, or the reverse).
import React from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { APP_VARIANT } from '../../config/variant';

const WrongAppScreen = () => {
  const { logout } = useAuth();
  const { theme } = useTheme();
  const store = Platform_OS_store();
  return (
    <View style={[s.wrap, { backgroundColor: theme.background }]}>
      <Text style={[s.title, { color: theme.foreground }]}>This is the {APP_VARIANT.appName} app</Text>
      <Text style={[s.body, { color: theme.hint }]}>
        Your account is set up for {APP_VARIANT.id === 'driver' ? 'riding and sending packages' : 'driving or delivering'}. Please use the “{APP_VARIANT.otherApp}” app with the same email and password.
      </Text>
      {!!store && <TouchableOpacity style={[s.btn, { backgroundColor: theme.accent }]} onPress={() => Linking.openURL(store).catch(() => {})}><Text style={s.btnTxt}>Get {APP_VARIANT.otherApp}</Text></TouchableOpacity>}
      <TouchableOpacity style={s.link} onPress={logout}><Text style={[s.linkTxt, { color: theme.hint }]}>Sign out</Text></TouchableOpacity>
    </View>
  );
};

// Store links come from the build config so they can differ per app; absent = the button is simply hidden.
import Constants from 'expo-constants';
import { Platform } from 'react-native';
function Platform_OS_store() {
  const links = Constants.expoConfig?.extra?.otherAppLinks || {};
  const url = Platform.OS === 'ios' ? links.ios : links.android;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 28 },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 10 },
  body: { fontSize: 15, lineHeight: 22, marginBottom: 24 },
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  link: { alignItems: 'center', marginTop: 18 },
  linkTxt: { fontSize: 14, fontWeight: '600' },
});
export default WrongAppScreen;
