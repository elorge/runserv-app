// backend/scripts/migrate-documents-private.js
//
// M13: move EXISTING public document files to private ("authenticated") storage and replace the stored link with a private reference.
//   node scripts/migrate-documents-private.js            -> DRY RUN (default): lists what would change, touches nothing
//   node scripts/migrate-documents-private.js --apply    -> performs the move. REHEARSE ON STAGING FIRST and take a database backup.
// Idempotent: rows already holding a private reference are skipped. Only SENSITIVE folders are moved.
'use strict';
require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const prisma = require('../src/lib/prisma');
const { DOC_URL_FIELDS, legacyUrlToParts, makePrivateRef, isSensitiveFolder } = require('../src/utils/storageRef');

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const APPLY = process.argv.includes('--apply');
const TARGETS = [
  { model: 'driverProfile', fields: DOC_URL_FIELDS.filter((f) => f !== 'fileUrl') },
  { model: 'deliveryPartnerProfile', fields: DOC_URL_FIELDS.filter((f) => f !== 'fileUrl') },
  { model: 'fleetPartnerDocument', fields: ['fileUrl'] },
];

(async () => {
  const stats = { seen: 0, skipped: 0, moved: 0, failed: 0 };
  for (const { model, fields } of TARGETS) {
    const rows = await prisma[model].findMany({ select: { id: true, ...Object.fromEntries(fields.map((f) => [f, true])) } });
    for (const row of rows) for (const f of fields) {
      const v = row[f]; if (!v) continue; stats.seen += 1;
      const parts = legacyUrlToParts(v);
      if (!parts || !isSensitiveFolder(parts.publicId.split('/').slice(0, -1).join('/'))) { stats.skipped += 1; continue; }
      console.log(`${APPLY ? 'MOVE' : 'WOULD MOVE'} ${model}.${f} ${row.id} -> ${parts.publicId}`);
      if (!APPLY) continue;
      try {
        await cloudinary.uploader.rename(parts.publicId, parts.publicId, { type: 'upload', to_type: 'authenticated', resource_type: parts.resourceType, overwrite: false, invalidate: true });
        await prisma[model].update({ where: { id: row.id }, data: { [f]: makePrivateRef(parts) } });
        stats.moved += 1;
      } catch (e) { stats.failed += 1; console.error(`FAILED ${model}.${f} ${row.id}: ${e.message}`); }
    }
  }
  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY_RUN', ...stats }));
  await prisma.$disconnect();
})();
