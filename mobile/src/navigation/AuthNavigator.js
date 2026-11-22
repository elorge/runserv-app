// mobile/src/navigation/AuthNavigator.js
import React, { useEffect, useState } from 'react';
import { createStackNavigator } from '@react-navigation/stack';

import LoginScreen            from '../screens/Auth/LoginScreen';
import RegisterScreen         from '../screens/Auth/RegisterScreen';
import OnboardingScreen       from '../screens/Auth/OnboardingScreen';
import TripPreviewScreen      from '../screens/Auth/TripPreviewScreen';
import TripPlannerScreen      from '../screens/Auth/TripPlannerScreen';
import EarnerPreviewScreen    from '../screens/Auth/EarnerPreviewScreen';
import OtpVerificationScreen  from '../screens/Auth/OtpVerificationScreen';
import ForgotPasswordScreen   from '../screens/Auth/ForgotPasswordScreen';
import LocationPickerScreen  from '../screens/Guest/LocationPickerScreen';
import GuestVerifyScreen    from '../screens/Guest/GuestVerifyScreen';
import GuestConfirmScreen   from '../screens/Guest/GuestConfirmScreen';
import GuestStatusScreen    from '../screens/Guest/GuestStatusScreen';
import GuestConvertScreen   from '../screens/Guest/GuestConvertScreen';
import { loadGuestSession, loadLastBooking } from '../services/guestSession';
import { APP_VARIANT }        from '../config/variant';
import { hasSeenPreview, loadTripDraft } from '../services/tripDraft';
import { hasSeenEarnerPreview, loadEarnerDraft } from '../services/earnerDraft';

const Stack = createStackNavigator();

/**
 * Customer app front door:
 *   - brand-new visitor, or someone with a saved trip → Trip Preview ("Boarding Pass")
 *   - returning visitor with no saved trip            → Login, as before
 * Driver app front door: the same idea for earners. A brand-new visitor, or someone with a saved Driver/Courier Pass, lands on
 * the Earnings Simulator / Parcel Run (EarnerPreview); a returning visitor goes straight to Login.
 */
const AuthNavigator = () => {
  const [initial, setInitial] = useState(null);
  const [resume, setResume] = useState(null);   // M16: a guest with a live booking reopens on its status screen

  useEffect(() => {
    if (initial) return undefined;
    let alive = true;
    (async () => {
      if (APP_VARIANT.id === 'customer') {
        const [seen, draft, gs, last] = await Promise.all([hasSeenPreview(), loadTripDraft(), loadGuestSession(), loadLastBooking()]);
        if (alive && gs && last) { setResume(last); setInitial('GuestStatus'); return; }
        if (alive) setInitial(!seen || draft ? 'TripPreview' : 'Login');
      } else {
        const [seen, draft] = await Promise.all([hasSeenEarnerPreview(), loadEarnerDraft()]);
        if (alive) setInitial(!seen || draft ? 'EarnerPreview' : 'Login');
      }
    })();
    return () => { alive = false; };
  }, [initial]);

  if (!initial) return null; // a few milliseconds: AsyncStorage read

  return (
  <Stack.Navigator
    initialRouteName={initial}
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="TripPreview"     component={TripPreviewScreen}     />
    <Stack.Screen name="TripPlanner"     component={TripPlannerScreen}     />
    <Stack.Screen name="EarnerPreview"   component={EarnerPreviewScreen}   />
    <Stack.Screen name="Login"           component={LoginScreen}           />
    <Stack.Screen name="Register"        component={RegisterScreen}        />
    <Stack.Screen name="Onboarding"      component={OnboardingScreen}      />

    {/* M16 guest booking. Customer app only; these routes exist ONLY in the signed-out stack, so a guest can never reach registered screens. */}
    {APP_VARIANT.id === 'customer' && (
      <>
        <Stack.Screen name="LocationPicker" component={LocationPickerScreen} />
        <Stack.Screen name="GuestVerify"    component={GuestVerifyScreen} />
        <Stack.Screen name="GuestConfirm"   component={GuestConfirmScreen} />
        <Stack.Screen name="GuestStatus"    component={GuestStatusScreen} initialParams={resume ? { bookingId: resume } : undefined} options={{ gestureEnabled: false }} />
        <Stack.Screen name="GuestConvert"   component={GuestConvertScreen} />
      </>
    )}

    {/*
      ForgotPassword — entered from LoginScreen's "Forgot password?" link.
      Handles both the email form and the post-send success state internally.
    */}
    <Stack.Screen
      name="ForgotPassword"
      component={ForgotPasswordScreen}
      options={{ gestureEnabled: true }}
    />

    {/*
      OtpVerification — pushed by LoginScreen when the backend signals
      requiresOtp: true. It receives { tempToken, method, maskedContact }
      as route.params.
    */}
    <Stack.Screen
      name="OtpVerification"
      component={OtpVerificationScreen}
      options={{ gestureEnabled: false }} // prevent swipe-back bypassing 2FA
    />
  </Stack.Navigator>
  );
};

export default AuthNavigator;