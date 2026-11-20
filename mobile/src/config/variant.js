// mobile/src/config/variant.js
// One codebase, two store apps. APP_VARIANT is chosen at build time (see app.config.js / eas.json):
//   customer → "Runserv"         : riders and senders (role CUSTOMER)
//   driver   → "Runserv Driver"  : drivers and couriers (roles DRIVER, DELIVERY_PARTNER)
// The same backend and accounts serve both. Each app only lets its own roles in; the server still enforces every
// permission, so this is a product boundary, not a security one.
import Constants from 'expo-constants';

export const VARIANTS = {
  customer: { id: 'customer', appName: 'Runserv',        roles: ['CUSTOMER'],                      otherApp: 'Runserv Driver' },
  driver:   { id: 'driver',   appName: 'Runserv Driver', roles: ['DRIVER', 'DELIVERY_PARTNER'],    otherApp: 'Runserv' },
};

/** Unknown or missing values fall back to the customer app, never to a mixed app. */
export const resolveVariant = (raw) => (String(raw || '').toLowerCase() === 'driver' ? VARIANTS.driver : VARIANTS.customer);

export const roleAllowed = (variant, role) => resolveVariant(variant?.id ?? variant).roles.includes(role);
export const rolesFor = (variant, allRoles) => allRoles.filter((r) => roleAllowed(variant, r.id ?? r));

export const APP_VARIANT = resolveVariant(Constants.expoConfig?.extra?.appVariant);
