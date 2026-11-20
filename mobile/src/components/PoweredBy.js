// mobile/src/components/PoweredBy.js
//
// "Powered by Elorge Technologies Limited" attribution line. Drop it at the
// bottom of any screen. The "Powered by" wording is translated (see `poweredBy`
// in the locale files); the company name is a proper noun and is never translated.
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../context/ThemeContext';

export const COMPANY_NAME = 'Elorge Technologies Limited';

export default function PoweredBy({ style }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  return (
    <Text style={[s.txt, { color: theme.hint }, style]}>
      {t('poweredBy', { company: COMPANY_NAME, defaultValue: `Powered by ${COMPANY_NAME}` })}
    </Text>
  );
}

const s = StyleSheet.create({
  txt: { textAlign: 'center', fontSize: 11, fontWeight: '500', marginTop: 4, marginBottom: 12 },
});
