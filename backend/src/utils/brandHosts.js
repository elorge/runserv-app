// backend/src/utils/brandHosts.js
// White label: which hostnames belong to which organisation's portal.
//   <slug>.<PORTAL_BASE_DOMAIN>   (default business.runserv.org)  or the company's own customDomain.
'use strict';
const prisma = require('../lib/prisma');

const baseDomain = () => String(process.env.PORTAL_BASE_DOMAIN || 'business.runserv.org').toLowerCase();
const cleanHost = (h) => String(h || '').toLowerCase().split(':')[0].trim();

/** Find the organisation whose portal lives at this host, or null. */
const findCompanyByHost = async (rawHost) => {
  const host = cleanHost(rawHost);
  if (!host) return null;
  const base = baseDomain();
  const select = { id: true, name: true, brandName: true, logoUrl: true, brandColor: true, brandAccent: true, tagline: true, supportEmail: true, slug: true, status: true };
  if (host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (/^[a-z0-9-]+$/.test(slug)) { const c = await prisma.company.findUnique({ where: { slug }, select }); return c?.status === 'ACTIVE' ? c : null; }
    return null;
  }
  const c = await prisma.company.findUnique({ where: { customDomain: host }, select });
  return c?.status === 'ACTIVE' ? c : null;
};

// CORS: is this browser origin one of our organisations' portals? (cached a minute)
let domainCache = { at: 0, set: new Set() };
const isPortalOrigin = async (origin) => {
  let host; try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const base = baseDomain();
  if (host.endsWith(`.${base}`) && /^[a-z0-9-]+$/.test(host.slice(0, -(base.length + 1)))) return true;
  if (Date.now() - domainCache.at > 60_000) {
    const rows = await prisma.company.findMany({ where: { customDomain: { not: null } }, select: { customDomain: true } });
    domainCache = { at: Date.now(), set: new Set(rows.map((r) => r.customDomain)) };
  }
  return domainCache.set.has(host);
};

module.exports = { findCompanyByHost, isPortalOrigin, baseDomain };
