'use strict';
// M15: the page behind the SMS tracking link  (GUEST_TRACKING_BASE_URL = https://<api-host>/t).
// A static shell: it reads the token from the URL and polls the existing public JSON endpoint GET /api/guest/track/:token.
// All values are written with textContent (addresses and names are user-supplied), the token is never logged, the page is not
// cached or indexed, and no Referer is sent. CSP: the inline script carries the per-request nonce set in app.js.
const express = require('express');
const { TRACK_RE } = require('../services/guestBooking.service');

const router = express.Router();

const PAGE = (nonce) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/><meta name="referrer" content="no-referrer"/><title>Track your Runserv booking</title>
<style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f6f7;color:#111}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:8px 0 2px}.ref{color:#666;font-size:13px;margin-bottom:14px}
.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.status{font-size:22px;font-weight:800}.sub{color:#555;font-size:14px;margin-top:4px}
.row{margin-top:10px;font-size:14px}.row b{display:block;color:#777;font-size:11px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px}
.note{background:#fff7e0;color:#6a4b00}.err{background:#fdecea;color:#8a1c14}.muted{color:#888;font-size:12px;text-align:center;margin-top:18px}
</style></head><body><main>
<h1>Your Runserv booking</h1><div class="ref" id="ref"></div>
<div class="card" id="main"><div class="status" id="status">Loading…</div><div class="sub" id="sub"></div></div>
<div class="card" id="route" hidden><div class="row"><b>From</b><span id="from"></span></div><div class="row"><b>To</b><span id="to"></span></div></div>
<div class="card" id="earner" hidden><div class="row"><b id="earnerLabel">Your driver</b><span id="earnerText"></span></div></div>
<div class="card note" id="note" hidden></div><div class="card err" id="error" hidden></div>
<div class="muted">This page updates automatically. Only people with this link can see it.</div>
</main>
<script nonce="${nonce}">
(function(){
  var token=(location.pathname.split('/').filter(Boolean).pop()||'');
  var LABEL={FINDING_DRIVER:'Finding your driver',DRIVER_ASSIGNED:'Driver is on the way',DRIVER_ARRIVED:'Your driver has arrived',IN_PROGRESS:'Trip in progress',COMPLETED:'Trip completed',CANCELLED:'Cancelled',
    FINDING_COURIER:'Finding a courier',COURIER_ASSIGNED:'Courier is on the way to collect',PARCEL_PICKED_UP:'Parcel collected',IN_TRANSIT:'On the way to the recipient',DELIVERED:'Delivered',DELIVERY_FAILED_RETURNING:'Delivery failed: parcel coming back',RETURNED_TO_SENDER:'Parcel returned to sender',UNKNOWN:'Status unavailable'};
  var DONE={COMPLETED:1,CANCELLED:1,DELIVERED:1,RETURNED_TO_SENDER:1};
  var timer=null,fails=0;
  function $(id){return document.getElementById(id);}
  function show(id,on){$(id).hidden=!on;}
  function money(a,c){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'NGN',maximumFractionDigits:0}).format(a);}catch(e){return (c||'')+' '+a;}}
  function fail(msg){show('error',true);$('error').textContent=msg;$('status').textContent='Not available';}
  function render(v){
    show('error',false);
    $('ref').textContent='Reference '+(v.reference||'');
    $('status').textContent=LABEL[v.status]||String(v.status||'');
    $('sub').textContent=v.service==='RIDE'?'Ride':'Parcel delivery';
    $('from').textContent=v.pickupAddress||'';$('to').textContent=v.dropoffAddress||'';show('route',!!(v.pickupAddress||v.dropoffAddress));
    if(v.earner){
      var bits=[v.earner.firstName];var veh=v.earner.vehicle||{};
      var car=[veh.color,veh.make,veh.model,veh.type].filter(Boolean).join(' ');
      if(car)bits.push(car);if(veh.plate)bits.push('plate '+veh.plate);
      $('earnerLabel').textContent=v.service==='RIDE'?'Your driver':'Your courier';$('earnerText').textContent=bits.join(' · ');show('earner',true);
    }else show('earner',false);
    var note=v.paymentNote||'';
    if(v.delivery&&v.delivery.failedFee)note+=' Return fee: '+money(v.delivery.failedFee.amount,v.delivery.failedFee.currency)+'.';
    if(v.status==='CANCELLED'&&v.cancellationReason)note=v.cancellationReason;
    $('note').textContent=note;show('note',!!note);
    if(DONE[v.status]&&timer){clearInterval(timer);timer=null;}
  }
  function load(){
    fetch('/api/guest/track/'+encodeURIComponent(token),{headers:{Accept:'application/json'},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j};});})
      .then(function(x){
        if(x.ok&&x.j&&x.j.data){fails=0;render(x.j.data);return;}
        if(x.status===404){if(timer){clearInterval(timer);timer=null;}fail('This tracking link is not valid or has expired.');return;}
        if(++fails>=3)fail('We could not refresh. Please check your connection.');
      }).catch(function(){if(++fails>=3)fail('We could not refresh. Please check your connection.');});
  }
  load();timer=setInterval(load,10000);
})();
</script></body></html>`;

router.get('/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  // A malformed token never gets the polling page: same message as an expired link, no API call made.
  if (!TRACK_RE.test(String(req.params.token || ''))) {
    return res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not valid</title><body style="font-family:Arial,sans-serif;text-align:center;padding:60px 24px"><h2>This tracking link is not valid or has expired.</h2></body>');
  }
  return res.type('html').send(PAGE(res.locals.cspNonce || ''));
});

module.exports = router;
