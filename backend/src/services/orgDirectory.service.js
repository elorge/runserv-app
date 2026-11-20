// backend/src/services/orgDirectory.service.js
// The company's staff directory (uploaded by HR) and its departments. Join requests are matched
// against it, and leavers marked here are delisted automatically.
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const corp = require('./corporate.service');

const { OrgError, normalizeStaffNumber } = corp;
const clean = (s, n = 120) => String(s ?? '').trim().slice(0, n);

// ── Departments ──────────────────────────────────────────────────────────────

const validateDeptBody = (b) => {
  const name = clean(b.name, 80);
  const costCenter = clean(b.costCenter || b.name, 40).toUpperCase();
  if (!name) throw new OrgError('Give the department a name.', 'ORG_DEPARTMENT_INVALID');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const out = { name, costCenter, monthlyBudget: num(b.monthlyBudget), maxTripAmount: num(b.maxTripAmount), approvalThreshold: num(b.approvalThreshold) };
  for (const k of ['monthlyBudget', 'maxTripAmount', 'approvalThreshold']) if (out[k] != null && !(out[k] >= 0)) throw new OrgError('Amounts must be zero or more.', 'ORG_DEPARTMENT_INVALID');
  return out;
};

const assertHeadInCompany = async (companyId, headId) => {
  if (!headId) return null;
  const h = await prisma.companyEmployee.findUnique({ where: { id: headId }, select: { companyId: true, isActive: true, inviteStatus: true } });
  if (!h || h.companyId !== companyId || !h.isActive || h.inviteStatus !== 'ACTIVE') throw new OrgError('Choose a department head from your listed staff.', 'ORG_SUPERVISOR_INVALID');
  return headId;
};

const createDepartment = async (companyId, body) => {
  const data = validateDeptBody(body);
  const headEmployeeId = await assertHeadInCompany(companyId, body.headEmployeeId);
  try { return await prisma.department.create({ data: { companyId, ...data, headEmployeeId } }); }
  catch (e) { if (e?.code === 'P2002') throw new OrgError('A department with that name already exists.', 'ORG_DEPARTMENT_EXISTS'); throw e; }
};

const updateDepartment = async (companyId, id, body) => {
  const d = await prisma.department.findUnique({ where: { id } });
  if (!d || d.companyId !== companyId) throw new OrgError('Department not found.', 'ORG_DEPARTMENT_INVALID', 404);
  const data = validateDeptBody({ name: d.name, costCenter: d.costCenter, ...body });
  const upd = { ...data };
  if ('headEmployeeId' in body) upd.headEmployeeId = await assertHeadInCompany(companyId, body.headEmployeeId);
  if ('isActive' in body) upd.isActive = Boolean(body.isActive);
  const saved = await prisma.department.update({ where: { id }, data: upd });
  // A department head is the supervisor of anyone in the department who has no supervisor yet.
  if (upd.headEmployeeId) await prisma.companyEmployee.updateMany({ where: { departmentId: id, supervisorId: null, id: { not: upd.headEmployeeId } }, data: { supervisorId: upd.headEmployeeId } });
  // …and is given the MANAGER portal role if they are plain staff, so they can see the department's costs.
  if (upd.headEmployeeId) await prisma.companyEmployee.updateMany({ where: { id: upd.headEmployeeId, role: 'STAFF' }, data: { role: 'MANAGER' } });
  return saved;
};

// ── Directory import ─────────────────────────────────────────────────────────

/**
 * rows: [{ staffNumber, fullName, department?, jobTitle?, supervisorStaffNumber?, email?, phone? }]
 * Departments named in the file are created (cost centre = name) when missing. Existing staff IDs
 * are updated; nobody is removed (use "mark as left").
 */
const importDirectory = async (companyId, rows) => {
  if (!Array.isArray(rows) || !rows.length) throw new OrgError('The file has no rows.', 'ORG_IMPORT_EMPTY');
  if (rows.length > 5000) throw new OrgError('Import at most 5,000 people at a time.', 'ORG_IMPORT_TOO_BIG');

  const depts = new Map((await prisma.department.findMany({ where: { companyId } })).map((d) => [d.name.toLowerCase(), d]));
  const result = { created: 0, updated: 0, skipped: [], departmentsCreated: 0 };
  const seen = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const line = i + 2; // spreadsheet row (1 = header)
    const staffNumber = normalizeStaffNumber(r.staffNumber);
    const fullName = clean(r.fullName);
    if (!staffNumber || !fullName) { result.skipped.push({ row: line, reason: 'Staff ID and full name are required' }); continue; }
    if (seen.has(staffNumber)) { result.skipped.push({ row: line, reason: `Duplicate staff ID ${staffNumber} in the file` }); continue; }
    seen.add(staffNumber);

    let departmentId = null; const dName = clean(r.department, 80);
    if (dName) {
      let d = depts.get(dName.toLowerCase());
      if (!d) { d = await prisma.department.create({ data: { companyId, name: dName, costCenter: dName.toUpperCase().slice(0, 40) } }); depts.set(dName.toLowerCase(), d); result.departmentsCreated++; }
      departmentId = d.id;
    }
    const data = {
      fullName, departmentId, jobTitle: clean(r.jobTitle, 80) || null, email: clean(r.email, 120).toLowerCase() || null, phone: clean(r.phone, 30) || null,
      supervisorStaffNumber: r.supervisorStaffNumber ? normalizeStaffNumber(r.supervisorStaffNumber) : null, status: 'ACTIVE', exitedAt: null,
    };
    const existing = await prisma.staffDirectoryEntry.findUnique({ where: { companyId_staffNumber: { companyId, staffNumber } } });
    if (existing) { await prisma.staffDirectoryEntry.update({ where: { id: existing.id }, data }); result.updated++; }
    else { await prisma.staffDirectoryEntry.create({ data: { companyId, staffNumber, ...data } }); result.created++; }
  }
  return result;
};

const listDirectory = async (companyId, { search, status, page = 1, limit = 50 }) => {
  const where = { companyId, ...(status && { status }),
    ...(search && { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { staffNumber: { contains: search, mode: 'insensitive' } }] }) };
  const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200); const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
  const [rows, total] = await Promise.all([
    prisma.staffDirectoryEntry.findMany({ where, orderBy: { fullName: 'asc' }, skip, take, include: { department: { select: { name: true } } } }),
    prisma.staffDirectoryEntry.count({ where }),
  ]);
  // Which of these people are already listed in the app?
  const listed = await prisma.companyEmployee.findMany({ where: { companyId, isActive: true, inviteStatus: 'ACTIVE', staffNumber: { in: rows.map((r) => r.staffNumber) } }, select: { staffNumber: true } });
  const set = new Set(listed.map((l) => l.staffNumber));
  return { entries: rows.map((r) => ({ ...r, onRunserv: set.has(r.staffNumber) })), pagination: { total, page: Math.max(parseInt(page) || 1, 1), pages: Math.ceil(total / take) } };
};

/** HR marks someone as having left in the directory; if they are listed in the app they are delisted. */
const markExited = async ({ companyId, entryId, byId, reason }) => {
  const e = await prisma.staffDirectoryEntry.findUnique({ where: { id: entryId } });
  if (!e || e.companyId !== companyId) throw new OrgError('Directory entry not found.', 'ORG_REQUEST_NOT_FOUND', 404);
  await prisma.staffDirectoryEntry.update({ where: { id: entryId }, data: { status: 'EXITED', exitedAt: new Date() } });
  const m = await prisma.companyEmployee.findFirst({ where: { companyId, staffNumber: e.staffNumber, isActive: true, inviteStatus: 'ACTIVE' } });
  if (m) await corp.delistEmployee({ companyId, employeeId: m.id, byId, reason });
  return { delisted: Boolean(m) };
};

module.exports = { createDepartment, updateDepartment, importDirectory, listDirectory, markExited };
