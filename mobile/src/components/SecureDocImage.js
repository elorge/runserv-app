import React, { useEffect, useState } from 'react';
import { Image, View, ActivityIndicator } from 'react-native';
import { resolveDocUrl } from '../services/documentAccess';

/** <Image> for a stored document: exchanges a redacted value for a signed link first. */
export default function SecureDocImage({ value, access, style, resizeMode = 'cover' }) {
  const [uri, setUri] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    resolveDocUrl(value, access).then((u) => { if (live) setUri(u); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [value, access?.source, access?.id, access?.field]);
  if (failed) return <View style={[style, { alignItems: 'center', justifyContent: 'center' }]} />;
  if (!uri) return <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator /></View>;
  return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
}
