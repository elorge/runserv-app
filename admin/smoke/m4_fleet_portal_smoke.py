import json, re, sys
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:4173'
ALL = dict(view=True, manageUsers=True, manageSettings=True, manageVehicles=True, manageDocuments=True, assignDrivers=True, seeTrips=True, seeFinance=True, seeDriverIdentity=True)
PERMS = {
  'OWNER': ALL, 'ADMIN': ALL,
  'OPERATIONS': dict(ALL, manageUsers=False, manageSettings=False, manageVehicles=False, manageDocuments=False, seeFinance=False),
  'VIEWER': dict(view=True, manageUsers=False, manageSettings=False, manageVehicles=False, manageDocuments=False, assignDrivers=False, seeTrips=True, seeFinance=False, seeDriverIdentity=False),
}
state = {'role': 'OWNER', 'fleetStatus': 'ACTIVE', 'user': 'fleet', 'applied': False, 'calls': []}

def fleet_partner():
    return dict(id='f1', legalName='Acme Mobility Ltd', tradingName='Acme Fleet', rcNumber='RC123456', email='a@acme.ng', phone='+2348012345678', address='Lagos',
                countryCode='NG', currency='NGN', status=state['fleetStatus'], verificationStatus='VERIFIED', verificationNotes=None, supportEmail=None,
                **({'commissionRate': '0.100000', 'settlementTermsDays': 7, 'payoutAccountName': 'Acme', 'payoutBankCode': '058', 'payoutAccountNumber': '0123456789'} if PERMS[state['role']]['seeFinance'] else {}))

COMPL_BAD = dict(docs={'insurance': dict(state='EXPIRED', expiresAt='2026-10-01', mandatory=True), 'roadworthy': dict(state='VALID', expiresAt='2027-06-01', mandatory=True), 'permit': dict(state='MISSING', expiresAt=None, mandatory=False)}, blockers=['insurance has expired'], warnings=[])
COMPL_OK = dict(docs={'insurance': dict(state='VALID', expiresAt='2027-05-01', mandatory=True), 'roadworthy': dict(state='VALID', expiresAt='2027-06-01', mandatory=True), 'permit': dict(state='MISSING', expiresAt=None, mandatory=False)}, blockers=[], warnings=[])
V1 = dict(id='v1', vehicleType='CAR', make='Toyota', model='Corolla', modelYear=2020, colour='Black', registrationNumber='LND123AA', status='ACTIVE', isActive=True, insuranceExpiresAt='2026-10-01', roadworthyExpiresAt='2027-06-01', permitExpiresAt=None, compliance=COMPL_BAD, assignments=[])
V2 = dict(id='v2', vehicleType='VAN', make='Ford', model='Transit', modelYear=2019, colour='White', registrationNumber='KJA456BC', status='ACTIVE', isActive=True, insuranceExpiresAt='2027-05-01', roadworthyExpiresAt='2027-06-01', permitExpiresAt=None, compliance=COMPL_OK, assignments=[dict(id='a1', driverUserId='d1')])
def trips():
    fin = PERMS[state['role']]['seeFinance']
    t = dict(id='t1', serviceType='RIDE', status='COMPLETED', currency='NGN', createdAt='2026-11-10T10:00:00Z', completedAt='2026-11-10T10:30:00Z', cancelledAt=None, cancellationReason=None,
             driver=dict(id='d1', firstName='Ade', lastName='Bello'), vehicle=dict(id='v1', registrationNumber='LND123AA', make='Toyota', model='Corolla'))
    if fin: t.update(fareAmount='5000.00', platformFeeAmount='500.00', fleetNetAmount='4500.00')
    return [t]
STMT = dict(id='s1', periodStart='2026-11-01T00:00:00Z', periodEnd='2026-11-08T00:00:00Z', grossAmount='5000.00', platformFeeAmount='500.00', adjustmentsAmount='0.00', netAmount='4500.00', currency='NGN', status='APPROVED', reference='FS-0001', paidAt=None, createdAt='2026-11-09T00:00:00Z')

def ok(data, status=200): return status, {'success': True, 'data': data}
def handle(method, path, body):
    state['calls'].append((method, path))
    r = state['role']
    if path == '/auth/login':
        email = body.get('email', '')
        role = 'ADMIN' if email.startswith('staff') else 'CUSTOMER'
        return 200, {'success': True, 'data': {'token': 'tok-' + email, 'user': dict(id='u1', email=email, phone='+2348000000000', firstName='Ngozi', lastName='Eze', role=role, isActive=True, isVerified=True, isSuspended=False, createdAt='', updatedAt='', supportCountries=[])}}
    if path == '/corporate/profile': return 403, {'success': False, 'message': 'no org'}
    if path == '/fleet/profile':
        if state['user'] == 'none' or (state['user'] == 'applicant' and not state['applied']): return 403, {'success': False, 'message': 'You do not have a fleet partner account.'}
        return ok(dict(role=r, permissions=PERMS[r], fleetPartner=fleet_partner()))
    if path == '/fleet/apply' and method == 'POST':
        state['applied'] = True; state['role'] = 'OWNER'; state['fleetStatus'] = 'PENDING'
        return ok(dict(fleetPartner=dict(id='f1', status='PENDING')), 201)
    if path == '/fleet/overview':
        o = dict(activeVehicles=2, activeDrivers=1, tripsInProgress=0, tripsCompleted30d=12, alerts=[dict(vehicleId='v1', registrationNumber='LND123AA', blockers=['insurance has expired'], warnings=[])])
        if PERMS[r]['seeFinance']: o.update(gross30d=60000, net30d=54000)
        return ok(o)
    if path == '/fleet/vehicles' and method == 'GET': return ok(dict(total=2, vehicles=[V1, V2]))
    if path == '/fleet/vehicles' and method == 'POST': return ok(dict(vehicle=dict(V2, id='v3', status='PENDING')), 201)
    if path == '/fleet/vehicles/v1': return ok(dict(vehicle=dict(V1, assignments=[]), compliance=COMPL_BAD))
    if path.startswith('/fleet/vehicles/') and method == 'PUT': return ok(dict(vehicle=V1, sentForReview=True))
    if path == '/fleet/documents' and method == 'GET': return ok(dict(documents=[dict(id='doc1', fleetPartnerId='f1', vehicleId='v1', documentType='insurance', fileUrl='https://res.example.com/i.pdf', documentNumber='INS-9', expiresAt='2026-10-01', verifiedAt=None, isApproved=False, rejectionNote='Photo is blurry', createdAt='2026-09-01T00:00:00Z')]))
    if path == '/fleet/documents/upload': return ok(dict(url='https://res.example.com/new.pdf', publicId='x'), 201)
    if path == '/fleet/documents' and method == 'POST': return ok(dict(document={}), 201)
    if path == '/fleet/drivers':
        ident = PERMS[r]['seeDriverIdentity']
        return ok(dict(assignments=[dict(id='a1', vehicleId='v2', driverUserId='d1', status='ACTIVE', startsAt='2026-10-01T00:00:00Z', endsAt=None, vehicle=dict(id='v2', registrationNumber='KJA456BC', vehicleType='VAN', make='Ford', model='Transit'), driver=dict(id='d1', firstName='Ade', lastName='Bello', **({'phone': '+2348099999999', 'email': 'ade@x.ng'} if ident else {})))]))
    if path == '/fleet/assignments' and method == 'POST': return ok(dict(assignment={}), 201)
    if path == '/fleet/trips': return ok(dict(total=1, trips=trips()))
    if path == '/fleet/settlements':
        if not PERMS[r]['seeFinance']: return 403, {'success': False, 'message': 'no'}
        return ok(dict(settlements=[STMT]))
    if path == '/fleet/settlements/s1': return ok(dict(settlement=STMT, trips=trips()))
    if path == '/fleet/settlements/s1/dispute': return ok(dict(settlement=dict(STMT, status='DISPUTED')))
    if path == '/fleet/users': return ok(dict(users=[dict(id='m1', role='OWNER', isActive=True, invitedAt='2026-09-01T00:00:00Z', acceptedAt=None, user=dict(id='u1', firstName='Ngozi', lastName='Eze', email='ngozi@acme.ng')),
                                                       dict(id='m2', role='VIEWER', isActive=True, invitedAt='2026-09-02T00:00:00Z', acceptedAt=None, user=dict(id='u2', firstName='Tunde', lastName='Ojo', email='tunde@acme.ng'))]))
    if path.startswith('/notifications') or path.startswith('/brand') or path.startswith('/public'): return 200, {'success': True, 'data': {'notifications': [], 'unreadCount': 0, 'count': 0}}
    return 200, {'success': True, 'data': {}}

failures = []
def check(name, cond):
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond: failures.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def new_page():
        ctx = b.new_context(viewport={'width': 1400, 'height': 900})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e) + ' @ ' + pg.url))
        def route(rt):
            req = rt.request
            path = re.sub(r'^https?://[^/]+/api', '', req.url.split('?')[0])
            try: body = req.post_data_json or {}
            except Exception: body = {}
            status, data = handle(req.method, path, body)
            rt.fulfill(status=status, content_type='application/json', body=json.dumps(data), headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        pg.route(re.compile(r'http://localhost:3000/api/.*'), route)
        return pg
    def sign_in(pg, email='fleet@acme.ng'):
        pg.goto(BASE + '/login'); pg.fill('input[type=email]', email); pg.fill('#password', 'secret123')
        pg.click('button[type=submit]')
    def nav_texts(pg): return pg.locator('[data-testid=fleet-sidebar] nav a').all_inner_texts()

    # ── 1. OWNER ─────────────────────────────────────────────────────────────
    state.update(role='OWNER', fleetStatus='ACTIVE', user='fleet'); pg = new_page(); sign_in(pg)
    pg.wait_for_selector('[data-testid=fleet-sidebar]')
    check('owner lands on fleet overview with fleet name', pg.get_by_role('heading', name='Acme Fleet').is_visible())
    check('owner sees all nav items', nav_texts(pg) == ['Overview', 'Vehicles', 'Drivers', 'Trips', 'Settlements', 'Team', 'Settings'])
    check('owner sees earnings summary', pg.locator('[data-testid=earnings-summary]').is_visible())
    check('overview lists blocked vehicle with reason', 'insurance has expired' in pg.locator('[data-testid=blocked-alerts]').inner_text())
    check('no status banner for an active fleet', pg.locator('[data-testid=fleet-status-banner]').count() == 0)

    pg.click('text=Vehicles >> nth=0'); pg.wait_for_selector('text=LND123AA')
    check('vehicle list shows blocked reason', pg.get_by_text('Blocked: insurance has expired').is_visible())
    check('owner has Add vehicle', pg.get_by_role('button', name='Add vehicle').is_visible())
    pg.get_by_role('button', name='Add vehicle').click(); pg.wait_for_selector('text=Add a vehicle')
    check('add-vehicle dialog says vehicle starts pending', pg.get_by_text('New vehicles start as').is_visible())
    pg.keyboard.press('Escape')
    pg.click('a:has-text("LND123AA")'); pg.wait_for_selector('[data-testid=vehicle-blockers]')
    check('vehicle page explains what blocks dispatch', 'insurance has expired' in pg.locator('[data-testid=vehicle-blockers]').inner_text())
    check('rejected document shows Runserv note', pg.get_by_text('Photo is blurry').is_visible())
    pg.get_by_role('button', name='Upload a document').click(); pg.wait_for_selector('[data-testid=doc-file]')
    pg.set_input_files('[data-testid=doc-file]', {'name': 'ins.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test'})
    pg.get_by_label('Expires').fill('2027-10-01') if pg.get_by_label('Expires').count() else None
    pg.get_by_role('button', name='Upload', exact=True).click(); pg.wait_for_timeout(600)
    check('upload step then register step both called', ('POST', '/fleet/documents/upload') in state['calls'] and ('POST', '/fleet/documents') in state['calls'])

    pg.goto(BASE + '/fleet/drivers'); pg.wait_for_selector('text=Ade Bello')
    check('owner sees driver contact details', pg.get_by_text('ade@x.ng').is_visible())
    pg.get_by_role('button', name='Assign driver').click(); pg.wait_for_selector('text=Assign a driver to a vehicle')
    check('assign dialog lists only free eligible vehicles', pg.locator('select option', has_text='KJA456BC').count() == 0 and pg.locator('select option', has_text='LND123AA').count() == 0)
    pg.keyboard.press('Escape')

    pg.goto(BASE + '/fleet/trips'); pg.wait_for_selector('text=LND123AA')
    check('owner sees fare columns on trips', pg.get_by_role('columnheader', name='Net to you').is_visible())
    pg.goto(BASE + '/fleet/settlements'); pg.wait_for_selector('text=FS-0001')
    pg.get_by_role('button', name='View').click(); pg.wait_for_selector('text=Net payable')
    check('statement offers dispute for an approved statement', pg.get_by_role('button', name='Dispute this statement').is_visible())
    pg.get_by_role('button', name='Dispute this statement').click(); pg.wait_for_selector('text=What looks wrong?')
    check('dispute needs a note', pg.get_by_role('button', name='Send dispute').is_disabled())
    pg.locator('textarea').fill('Fee looks too high'); pg.get_by_role('button', name='Send dispute').click(); pg.wait_for_timeout(500)
    check('dispute posted', ('POST', '/fleet/settlements/s1/dispute') in state['calls'])
    pg.goto(BASE + '/fleet/team'); pg.wait_for_selector('text=tunde@acme.ng')
    check('owner row has no role control', pg.get_by_label('Role for ngozi@acme.ng').count() == 0 and pg.get_by_label('Role for tunde@acme.ng').count() == 1)
    pg.goto(BASE + '/fleet/settings'); pg.wait_for_selector('text=Payout account')
    check('settings show agreed fee read-only', pg.get_by_text('10%').first.is_visible())
    check('fleet user cannot open staff fleet admin', (pg.goto(BASE + '/fleets'), pg.wait_for_timeout(500), pg.url.rstrip('/') == BASE)[2])
    pg.context.close()

    # ── 2. VIEWER ────────────────────────────────────────────────────────────
    state.update(role='VIEWER', fleetStatus='ACTIVE', user='fleet'); pg = new_page(); sign_in(pg)
    pg.wait_for_selector('[data-testid=fleet-sidebar]')
    check('viewer nav has no drivers / settlements / team / settings', nav_texts(pg) == ['Overview', 'Vehicles', 'Trips'])
    check('viewer overview hides earnings', pg.locator('[data-testid=earnings-summary]').count() == 0)
    pg.goto(BASE + '/fleet/vehicles'); pg.wait_for_selector('text=LND123AA')
    check('viewer cannot add vehicles', pg.get_by_role('button', name='Add vehicle').count() == 0)
    pg.goto(BASE + '/fleet/vehicles/v1'); pg.wait_for_selector('[data-testid=vehicle-blockers]')
    check('viewer cannot upload or edit dates', pg.get_by_role('button', name='Upload a document').count() == 0 and pg.get_by_role('button', name='Edit document dates').count() == 0)
    pg.goto(BASE + '/fleet/trips'); pg.wait_for_selector('text=LND123AA')
    check('viewer sees trips without any money', pg.get_by_role('columnheader', name='Fare').count() == 0 and '5,000' not in pg.content())
    pg.goto(BASE + '/fleet/settlements'); pg.wait_for_selector('text=Settlements')
    check('viewer typing the finance URL gets a restriction message', pg.get_by_text('visible to Owner, Admin and Finance roles').is_visible() and pg.get_by_text('FS-0001').count() == 0)
    pg.goto(BASE + '/fleet/team'); pg.wait_for_selector('text=Team')
    check('viewer typing the team URL gets a restriction message', pg.get_by_text('Only the Owner and Admins can manage the team').is_visible())
    pg.context.close()

    # ── 3. OPERATIONS ────────────────────────────────────────────────────────
    state.update(role='OPERATIONS', fleetStatus='ACTIVE', user='fleet'); pg = new_page(); sign_in(pg)
    pg.wait_for_selector('[data-testid=fleet-sidebar]')
    check('operations nav: drivers yes, finance/team/settings no', nav_texts(pg) == ['Overview', 'Vehicles', 'Drivers', 'Trips'])
    pg.goto(BASE + '/fleet/trips'); pg.wait_for_selector('text=LND123AA')
    check('operations cannot see money on trips', pg.get_by_role('columnheader', name='Fare').count() == 0)
    pg.context.close()

    # ── 4. Suspended fleet banner ────────────────────────────────────────────
    state.update(role='OWNER', fleetStatus='SUSPENDED', user='fleet'); pg = new_page(); sign_in(pg)
    pg.wait_for_selector('[data-testid=fleet-status-banner]')
    check('suspended fleet shows a clear banner', 'suspended' in pg.locator('[data-testid=fleet-status-banner]').inner_text().lower())
    pg.goto(BASE + '/fleet/drivers'); pg.wait_for_selector('text=Drivers')
    check('assign is disabled while suspended', pg.get_by_role('button', name='Assign driver').is_disabled())
    pg.context.close()

    # ── 5. Customer with no org or fleet ────────────────────────────────────
    state.update(user='none'); pg = new_page(); sign_in(pg, 'plain@x.ng'); pg.wait_for_timeout(800)
    check('plain customer is refused with a pointer to apply', pg.get_by_text('no organisation or fleet dashboard access').is_visible())
    check('login page links to the fleet application', pg.get_by_role('button', name='Apply for a fleet partner account').is_visible())
    pg.context.close()

    # ── 6. Apply flow ────────────────────────────────────────────────────────
    state.update(user='applicant', applied=False, fleetStatus='PENDING'); pg = new_page()
    pg.goto(BASE + '/fleet/apply'); pg.wait_for_selector('[data-testid=apply-signin]')
    pg.fill('input[type=email]', 'new@x.ng'); pg.fill('input[type=password]', 'secret123'); pg.get_by_role('button', name='Continue').click()
    pg.wait_for_selector('[data-testid=apply-form]')
    check('applicant is not a stored session before applying', 'auth-storage' not in (pg.evaluate("Object.keys(localStorage).join(',')")))
    pg.get_by_label('Registered business name').fill('Zenith Movers Ltd'); pg.get_by_role('button', name='Send application').click()
    pg.wait_for_selector('[data-testid=fleet-status-banner]')
    check('after applying the portal opens with the under-review banner', 'application' in pg.locator('[data-testid=fleet-status-banner]').inner_text().lower())
    pg.context.close()

    portal_errors = list(errors); del errors[:]
    # ── 7. Runserv staff stay in the admin panel ────────────────────────────
    state.update(role='OWNER', fleetStatus='ACTIVE', user='fleet'); pg = new_page(); sign_in(pg, 'staff@runserv.org'); pg.wait_for_timeout(800)
    pg.goto(BASE + '/fleet/vehicles'); pg.wait_for_timeout(500)
    check('staff cannot open fleet portal pages', pg.locator('[data-testid=fleet-sidebar]').count() == 0)
    pg.context.close()
    b.close()

staff_errors = list(errors)
real = [e for e in portal_errors if 'ResizeObserver' not in e]
print('errors raised only in the staff scenario (admin Dashboard given an empty mock):', len(staff_errors))
check('no uncaught page errors in any fleet-portal scenario', not real)
if real: print(real[:5])
print('\nFAILED:' if failures else '\nALL PASSED', failures if failures else '')
sys.exit(1 if failures else 0)
