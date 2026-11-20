// mobile/app.config.js
// Load order matters. dotenv NEVER overwrites a variable that is already set (override is off), so:
//   1. real environment (shell / EAS build profile, e.g. APP_VARIANT in eas.json) always wins,
//   2. then .env.local, 3. then .env.
// Previously both files used `override: true`, which let a developer's .env silently replace the EAS profile's
// APP_VARIANT and build the wrong app (launch-readiness guide §7.1).
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const ANDROID_KEY = process.env.GOOGLE_MAPS_API_KEY_ANDROID ?? '';
const IOS_KEY     = process.env.GOOGLE_MAPS_API_KEY_IOS     ?? '';
const API_URL     = process.env.API_URL ?? 'https://api.runserv.org/api';

// Two store apps from one codebase. APP_VARIANT=customer (default) or driver; set by eas.json profiles or
// `node scripts/with-variant.js <variant> expo start`. The customer variant keeps the existing store identity unchanged.
const VARIANT = String(process.env.APP_VARIANT || 'customer').toLowerCase() === 'driver' ? 'driver' : 'customer';
const fs = require('fs');
const IS_EAS = !!process.env.EAS_BUILD;   // set by EAS Build; local runs may legitimately lack native config files
const V = {
  customer: { name: 'Runserv', slug: 'runserv', scheme: 'runserv', id: 'org.runserv.app',
              projectId: 'da8a9bc7-41c1-44d2-8d1d-a52b0dc46fb7',
              // Firebase config: prefer EAS "file" environment variables (injected at build time, never committed); fall back to a local file.
              gIos: process.env.GOOGLE_SERVICES_PLIST || './GoogleService-Info.plist', gAndroid: process.env.GOOGLE_SERVICES_JSON || './google-services.json' },
  driver:   { name: 'Runserv Driver', slug: 'runserv-driver', scheme: 'runserv-driver', id: 'org.runserv.driver',
              // The driver app needs its OWN Expo project: run `eas init` with APP_VARIANT=driver, then set EAS_PROJECT_ID_DRIVER.
              projectId: process.env.EAS_PROJECT_ID_DRIVER || null,
              gIos: process.env.GOOGLE_SERVICES_PLIST_DRIVER || './GoogleService-Info.driver.plist', gAndroid: process.env.GOOGLE_SERVICES_JSON_DRIVER || './google-services.driver.json' },
}[VARIANT];

// Fail an EAS build EARLY and clearly instead of producing a misconfigured binary.
if (IS_EAS) {
  const problems = [];
  if (!V.projectId) problems.push(`EAS project ID for the ${VARIANT} app is not set. Run \`eas init\` with APP_VARIANT=${VARIANT} and set EAS_PROJECT_ID_DRIVER as an EAS environment variable.`);
  for (const [label, f] of [['Android google-services', V.gAndroid], ['iOS GoogleService-Info', V.gIos]]) {
    if (!fs.existsSync(f)) problems.push(`${label} file not found at "${f}". Provide it as an EAS file environment variable (GOOGLE_SERVICES_JSON[_DRIVER] / GOOGLE_SERVICES_PLIST[_DRIVER]) or add the file.`);
  }
  if (problems.length) throw new Error('[app.config.js] Build configuration incomplete:\n - ' + problems.join('\n - '));
}

console.log('[app.config.js] variant:', VARIANT, '| API_URL:', API_URL);

module.exports = {
  expo: {
    name:        V.name,
    slug:        V.slug,
    scheme:      V.scheme,
    version:     '1.1.0',
    orientation: 'portrait',
    icon:        './assets/icon.png',
    userInterfaceStyle: 'dark',

    runtimeVersion: { policy: 'appVersion' },
    ...(V.projectId ? { updates: { url: `https://u.expo.dev/${V.projectId}` } } : {}),

    splash: {
      image:      './assets/splash.png',
      resizeMode: 'cover',
      backgroundColor: '#FFFFFF',
    },

    assetBundlePatterns: ['**/*'],

    plugins: [
      [
        'expo-image-picker',
        { photosPermission: 'Allow Runserv to access your photos.', cameraPermission: 'Allow Runserv to use your camera to take a profile photo.' },
      ],
      [
        'expo-font',
      ],
      // MapLibre v11 native module (rebuild the dev client / EAS build after adding it; Expo Go cannot load it)
      '@maplibre/maplibre-react-native',
      [
        'expo-secure-store',
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Runserv needs your location to find nearby drivers and show your position on the map.',
          locationAlwaysAndWhenInUsePermission:
            'Runserv uses your location to track your ride in real time.',
        },
      ],
      './plugins/withRemoveMediaPermissions.js'
    ],

    ios: {
      supportsTablet:   true,
      bundleIdentifier: V.id,
      googleServicesFile: V.gIos,
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Runserv needs your location to find nearby drivers and show your position on the map.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'Runserv uses your location to track your ride in real time.',
        ITSAppUsesNonExemptEncryption: false,
      },
      config: {
        googleMapsApiKey: IOS_KEY,
      },
    },

    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#FFFFFF',
      },
      package:     V.id,
      googleServicesFile: V.gAndroid,
      permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
      config: {
        googleMaps: {
          apiKey: ANDROID_KEY,
        },
      },
    },

    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
    },

    extra: {
      apiUrl: API_URL,
      appVariant: VARIANT,
      // Where the "wrong app" screen sends people (https only). Set when the store listings exist.
      otherAppLinks: VARIANT === 'driver'
        ? { ios: process.env.CUSTOMER_APP_IOS_URL, android: process.env.CUSTOMER_APP_ANDROID_URL }
        : { ios: process.env.DRIVER_APP_IOS_URL, android: process.env.DRIVER_APP_ANDROID_URL },
      // Google sign-in (create these in Google Cloud → Credentials → OAuth client IDs)
      google: {
        webClientId:     process.env.GOOGLE_WEB_CLIENT_ID,
        iosClientId:     process.env.GOOGLE_IOS_CLIENT_ID,
        androidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID,
      },
      eas: V.projectId ? { projectId: V.projectId } : {},
    },
  },
};