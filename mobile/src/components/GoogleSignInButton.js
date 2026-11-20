// mobile/src/components/GoogleSignInButton.js
// "Continue with Google": fast sign-up / sign-in. Shows nothing until Google client IDs are configured
// (see app.config.js → extra.google). The server verifies the ID token and creates the account.
import React, { useEffect } from 'react';
import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';

WebBrowser.maybeCompleteAuthSession();

const ids = Constants.expoConfig?.extra?.google ?? {};
const configured = Boolean(ids.webClientId || ids.iosClientId || ids.androidClientId);

const Inner = ({ onToken, disabled, theme, mode }) => {
  const [request, response, prompt] = Google.useIdTokenAuthRequest({
    webClientId: ids.webClientId, iosClientId: ids.iosClientId, androidClientId: ids.androidClientId,
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.params?.id_token ?? response.authentication?.idToken;
      if (idToken) onToken(idToken);
    }
  }, [response]); // eslint-disable-line

  return (
    <View style={{ marginBottom: 14 }}>
      <View style={st.divider}>
        <View style={[st.line, { backgroundColor: theme.border }]} />
        <Text style={[st.or, { color: theme.hint }]}>or</Text>
        <View style={[st.line, { backgroundColor: theme.border }]} />
      </View>
      <TouchableOpacity
        onPress={() => prompt()} disabled={!request || disabled} activeOpacity={0.85}
        style={[st.btn, { borderColor: theme.border, backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.06)' : '#fff', opacity: !request || disabled ? 0.55 : 1 }]}
        accessibilityRole="button" accessibilityLabel="Continue with Google">
        <Ionicons name="logo-google" size={18} color="#EA4335" />
        <Text style={[st.txt, { color: theme.foreground }]}>Continue with Google</Text>
      </TouchableOpacity>
    </View>
  );
};

export default function GoogleSignInButton(props) {
  if (!configured) return null;
  return <Inner {...props} />;
}

const st = StyleSheet.create({
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  line: { flex: 1, height: StyleSheet.hairlineWidth }, or: { fontSize: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 50, borderRadius: 14, borderWidth: 1 },
  txt: { fontSize: 15, fontWeight: '600' },
});
