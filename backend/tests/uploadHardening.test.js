'use strict';
jest.mock('../src/services/upload.service', () => ({ uploadBase64: jest.fn(async (u, f) => ({ url: 'x', folder: f })), uploadPrivateBuffer: jest.fn(async () => ({ ref: 'cldp:image:png:runserv/kyc/ids/abc', publicId: 'runserv/kyc/ids/abc' })), deleteFile: jest.fn() }));
const svc = require('../src/services/upload.service');
const c = require('../src/controllers/upload.controller');
const res = () => ({ status() { return this; }, json(b) { this.body = b; return this; } });
const up = (body) => c.uploadBase64({ body, user: { id: 'u' } }, res());
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
beforeEach(() => jest.clearAllMocks());
test('a normal image into a PUBLIC folder works', async () => { await up({ base64Data: png, folder: 'runserv/profile' }); expect(svc.uploadBase64).toHaveBeenCalledWith(png, 'runserv/profile'); });
test('M13: an identity document goes to PRIVATE storage and returns a reference, never a link', async () => {
  const r = res(); await c.uploadBase64({ body: { base64Data: png, folder: 'runserv/kyc/ids' }, user: { id: 'u' } }, r);
  expect(svc.uploadBase64).not.toHaveBeenCalled(); expect(svc.uploadPrivateBuffer).toHaveBeenCalled();
  expect(r.body.data).toMatchObject({ url: 'cldp:image:png:runserv/kyc/ids/abc', private: true });
});
test('M13: content that is not really an image/PDF is refused even if it claims to be', async () => {
  await expect(up({ base64Data: 'data:image/png;base64,' + Buffer.from('<html><script>x</script></html>').toString('base64'), folder: 'runserv/kyc/ids' })).rejects.toMatchObject({ statusCode: 400 });
  expect(svc.uploadPrivateBuffer).not.toHaveBeenCalled();
});
test('a URL is refused (the storage provider would fetch it for us)', async () => { await expect(up({ base64Data: 'https://evil.example/x.png' })).rejects.toMatchObject({ statusCode: 400 }); });
test('non image/pdf types are refused', async () => { await expect(up({ base64Data: 'data:text/html;base64,PGh0bWw+' })).rejects.toMatchObject({ statusCode: 400 }); });
test('the fleet documents folder and unknown folders are refused', async () => { for (const f of ['runserv/fleet/documents', '../x', 'other']) await expect(up({ base64Data: png, folder: f })).rejects.toMatchObject({ statusCode: 400 }); });
test('oversized uploads are refused', async () => { await expect(up({ base64Data: 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024) })).rejects.toMatchObject({ statusCode: 413 }); });
test('only staff can delete, and only inside runserv/', async () => {
  await expect(c.deleteFile({ params: { publicId: 'runserv%2Fkyc%2Fids%2Fa' }, user: { role: 'CUSTOMER' } }, res())).rejects.toMatchObject({ statusCode: 403 });
  await expect(c.deleteFile({ params: { publicId: 'other%2Fa' }, user: { role: 'ADMIN' } }, res())).rejects.toMatchObject({ statusCode: 403 });
  await c.deleteFile({ params: { publicId: 'runserv%2Fkyc%2Fids%2Fa' }, user: { role: 'ADMIN' } }, res()); expect(svc.deleteFile).toHaveBeenCalledWith('runserv/kyc/ids/a');
});
