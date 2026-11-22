// mobile/src/components/earn/RoadCardHost.js
// The dashboard's "Road to online" card. The dashboard already holds the profile, so no extra request: the road is derived
// from it. Hidden once every step is done. `known` is false until the profile request has really answered (a network
// failure must not look like "no profile yet").
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RoadCard, planText } from './RoadToOnline';
import { DRIVER_ACCENT, COURIER_ACCENT } from './EarnerPass';
import { roadFromProfile } from '../../hooks/useRoadToOnline';
import { loadEarnerDraft } from '../../services/earnerDraft';
import { formatMoneyFor } from '../../utils/tripEstimate';
import { useEarnT } from '../../i18n/earnerStrings';

export default function RoadCardHost({ role, profile, known, theme, navigation }) {
  const { t } = useTranslation();
  const e = useEarnT(t);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    loadEarnerDraft().then(setDraft);
    return navigation?.addListener?.('focus', () => loadEarnerDraft().then(setDraft));
  }, [navigation]);
  const road = useMemo(() => (known ? roadFromProfile(role, profile) : null), [known, role, profile]);
  if (!road || road.complete) return null;
  return (
    <RoadCard
      role={role} road={road} theme={theme} e={e}
      accent={role === 'DRIVER' ? DRIVER_ACCENT : COURIER_ACCENT}
      planText={planText(e, draft, role, formatMoneyFor)}
      onPress={() => navigation.navigate('RoadToOnline')}
    />
  );
}
