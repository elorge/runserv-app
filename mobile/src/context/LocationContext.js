// mobile/src/context/LocationContext.js — the person's own current GPS position (customer side), read once on request.
// (Previously returned a hard-coded country centre. Driver/courier live tracking lives in services/liveLocation.js.)
import React, { createContext, useContext, useState, useCallback } from 'react';
import * as Location from '../shims/Location';

const LocationContext = createContext(null);

export const LocationProvider = ({ children }) => {
  const [location, setLocation] = useState(null);   // { latitude, longitude, accuracy, timestamp } or null: never a made-up place
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setError('PERMISSION_DENIED'); return null; }
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const loc = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null, timestamp: p.timestamp };
      setLocation(loc); setError(null);
      return loc;
    } catch (e) { setError(e?.message || 'LOCATION_ERROR'); return null; }
  }, []);

  return <LocationContext.Provider value={{ location, error, refresh }}>{children}</LocationContext.Provider>;
};

export const useLocation = () => useContext(LocationContext);
