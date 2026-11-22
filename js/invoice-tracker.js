import { BUSINESS_TIME_ZONE } from './business-date.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, updatedLabel } from './auto-refresh.mjs';
import { localToday, isCalendarDay } from './calendar-model.js';
import { partnerName } from './visual-system.js';
import { uuidv4 } from './uuid.js';
import { AGES, projectInvoices, validInvoiceTracker, isInvoiceBaseVersion, invoiceSummary, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
const E=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ownerLabel = owner => partnerName(owner) || 'Unassigned';
const missingAmounts = count => count ? ` · ${count} without a recorded amount` : '';
const statusLabel=row=>row.status==='paid'?'Paid':row.status==='awaiting'?'Awaiting invoice':row.overdue?'Overdue':'Unpaid';
const isEarlierVersion = (version, current) => current != null && (version === null || version < current);
const paymentRefusals = new Map([
  ['version_conflict', 'Invoice changed before the payment could be saved.'],
  ['invoice_not_unpaid', 'Only unpaid invoices can be marked paid.'],
  ['invalid_received_on', 'Enter a valid payment date.'],
  ['invalid_field_value', 'Check the payment details and try again.'],
  ['missing_required', 'Fill in the payment details and try again.'],
  ['payment_date_out_of_range', 'Choose a payment date from the invoice date through today.'],
  ['invoice_not_found', 'This invoice could not be found.'],
  ['key_reuse', 'Review the invoice before trying again.'],
  ['actor_not_provisioned', 'Your account cannot mark this invoice paid.'],
  ['database_refused_the_statement', 'This payment could not be saved.'],
]);
export function mountInvoiceTracker({ document, window, client, today=localToday, intervalMs }) {
  const $=id=>document.getElementById(id);
  let rows=null,status='all',age=null,selected=null,opener=null,disposed=false;
  let snapshot=null, readSequence=0;
  let invoiceStates = new Map();
  const preparingPayments=new Set();
  let paymentStore=null;
  let paymentActor=null;
  function loadPayments(actor) {
    const key=`doctorcre:invoice-payments:v1:${client.mode || 'live'}:${actor}`;
    if(paymentStore===key)return;
    const restored=new Map();
    const saved=JSON.parse(window.sessionStorage.getItem(key) || '[]');
    if(!Array.isArray(saved))throw new Error('Invalid payment recovery');
    for(const args of saved){
      if(!args || typeof args.commission_id!=='string' || !isInvoiceBaseVersion(args.base_version)
        || !isCalendarDay(args.received_on) || typeof args.idempotency_key!=='string' || !args.idempotency_key)throw new Error('Invalid payment recovery');
      restored.set(args.commission_id, { sequence: 0, confirmed: false, pending: { args: Object.freeze(args), readAfter: 0 } });
    }
    paymentStore=key;paymentActor=actor;invoiceStates=restored;
  }
  function savePayments() {
    const requests = [...invoiceStates.values()].flatMap(({ pending }) => pending ? [pending.args] : []);
    window.sessionStorage.setItem(paymentStore, JSON.stringify(requests));
  }
  function confirmPayment(payment) {
    payment.sequence = readSequence;
    payment.confirmed = true;
    payment.pending = null;
    savePayments();
  }
  function withEntry(tracker, id, entry) {
    const entries = tracker.entries.filter(row => row.commission_id !== id);
    if (entry) entries.push(entry);
    return { ...tracker, entries };
  }
  function entriesByCommissionId(tracker) {
    return new Map(tracker?.entries.filter(row => row.commission_id).map(row => [row.commission_id, row]));
  }
  function applyRead(next, sequence, invoiceId) {
    const currentEntries = entriesByCommissionId(snapshot);
    const entries = entriesByCommissionId(next);
    // A save checks only its own invoice, even though the tracker returns the whole list.
    const ids = invoiceId ? [invoiceId] : new Set([...entries.keys(), ...currentEntries.keys()]);
    for (const id of ids) {
      const state = invoiceStates.get(id) ?? { sequence: 0, confirmed: false, pending: null };
      const entry = entries.get(id);
      const current = currentEntries.get(id);
      const stale = sequence <= state.sequence || (state.confirmed && isEarlierVersion(entry?.base_version, current?.base_version));
      const received = entry?.status === 'received' && state.pending;
      const checksSave = received && received.readAfter !== null && sequence > received.readAfter;
      if (stale || (received && !checksSave)) {
        if (current) entries.set(id, current);
        else entries.delete(id);
        continue;
      }
      state.sequence = sequence;
      invoiceStates.set(id, state);
      if (checksSave) confirmPayment(state);
    }
    setSnapshot(invoiceId ? withEntry(snapshot, invoiceId, entries.get(invoiceId))
      : { ...next, entries: [...next.entries.filter(row => !row.commission_id), ...entries.values()] });
  }
  function setSnapshot(next) {
    const projected = projectInvoices(next, { today: today() });
    if (!projected) throw new Error('Invalid invoice snapshot');
    snapshot = next;
    rows = projected;
  }
  const pageParams = new URL(window.location.href).searchParams;
  const requested = pageParams.get('invoice');
  let requestHandled=false;
  const focusVisible=element=>{const target=element?.isConnected&&!element.disabled&&!element.closest('[inert]')&&element.getClientRects().length?element:$('refreshInvoices');target.focus();};
  const paint=(target,html)=>{
    if(target.innerHTML===html)return;
    const key=target.contains(document.activeElement)?document.activeElement.dataset.invoiceKey:null;
    target.innerHTML=html;
    if(key)focusVisible([...target.querySelectorAll('[data-invoice-key]')].find(node=>node.dataset.invoiceKey===key));
  };
  const scoped=()=>rows?.filter(row=>!$('invoiceOwner').value || row.owner===$('invoiceOwner').value);
  function render() {
    const owned=scoped();
    $('invoiceRows').setAttribute('aria-busy',String(!rows));
    $('invoiceUpdated').textContent=updatedLabel(snapshot?.observed_at, BUSINESS_TIME_ZONE);
    if(!owned){paint($('invoiceTotals'),'');paint($('invoiceAging'),'');paint($('invoiceRows'),'<p>Updating…</p>');return;}
    const totals=invoiceSummary(owned);
    const hasOwedAmount = totals.unpaid > totals.unknown;
    paint($('invoiceTotals'), `
      <div class="invoice-total owed glass">
        <span>Owed to DoctorCRE</span>
        ${hasOwedAmount ? `<strong>${E(invoiceMoney(totals.owed))}</strong>`
          : '<strong class="invoice-missing-amount">No invoice amounts recorded yet</strong>'}
        <small>${totals.unpaid} unpaid${hasOwedAmount ? missingAmounts(totals.unknown) : ''}</small>
      </div>
      <div class="invoice-total glass"><span>Awaiting invoice</span><strong>${totals.awaiting}</strong></div>
      <div class="invoice-total glass"><span>Paid</span><strong>${totals.paid}</strong></div>`);
    const ceiling = Math.max(1, ...totals.buckets.map(bucket => bucket.amount));
    paint($('invoiceAging'), totals.buckets.map(bucket => {
      const hasAmount = bucket.count > bucket.unknown;
      return `<button class="invoice-age" data-age="${bucket.index}" data-invoice-key="age:${bucket.index}" aria-pressed="${age===bucket.index}">
        <span class="age-label">${bucket.label}</span>
        ${hasAmount ? `<strong>${E(invoiceMoney(bucket.amount))}</strong>` : ''}
        <svg class="age-track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="age-base" width="100" height="8" rx="4"/><rect class="age-fill" width="${bucket.amount / ceiling * 100}" height="8" rx="4"/></svg>
        <small>${bucket.count} ${bucket.count===1?'invoice':'invoices'}${hasAmount ? missingAmounts(bucket.unknown) : ''}</small>
      </button>`;
    }).join(''));
    const term=$('invoiceSearch').value.trim().toLocaleLowerCase();
    const visible=owned.filter(row=>(status==='all'||row.status===status)&&(age===null||(row.status==='unpaid'&&row.bucket===age))&&row.name.toLocaleLowerCase().includes(term));
    $('invoiceCount').textContent=`Invoices · ${visible.length}`;$('invoiceFiltered').textContent=age===null?'':AGES[age];
    paint($('invoiceRows'), visible.length ? visible.map(row => `
      <button type="button" class="invoice-row ${row.status}${row.overdue?' overdue':''}" data-age="${row.bucket ?? ''}" data-invoice-key="${E(row.key)}" data-invoice="${E(row.key)}">
        <span><strong>${E(row.name)}</strong><span class="invoice-sub">${E(ownerLabel(row.owner))}</span></span>
        <span class="row-date">${row.invoiceDay ? E(invoiceDate(row.invoiceDay)) : ''}</span>
        <span class="row-money">${row.amount === null ? "" : E(invoiceMoney(row.amount))}</span>
        <span class="invoice-state">${statusLabel(row)}</span>
        <span class="row-age">${row.age === null ? '' : `${row.age}<small>${row.status==='paid'?'days to payment':'days outstanding'}</small>`}</span>
      </button>`).join('') : '<p>No invoices match</p>');
    $('allAges').setAttribute('aria-pressed',String(age===null));
    for(const button of $('invoiceTabs').querySelectorAll('[data-status]'))button.setAttribute('aria-pressed',String(button.dataset.status===status));
    if(selected)renderDetail();
    if(requested&&!requestHandled){const row=rows.find(row=>row.key===requested);if(row){requestHandled=true;openDetail(row.key);}}
  }
  function renderDetail() {
    const row=rows?.find(row=>row.key===selected);
    if(!row){closeDetail();return;}
    $('invoiceDetailTitle').textContent=row.name;
    paint($('invoiceDealAction'), /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.deal_id)
      ? `<a data-invoice-key="deal:${E(row.key)}" href="/deals?deal=${E(encodeURIComponent(row.deal_id))}">Open deal</a>` : '<span>Deal unavailable</span>');
    const docParams = new URLSearchParams({ deal: row.deal_id, invoice: row.key });
    if (pageParams.get('mode') === 'live') docParams.set('mode', 'live');
    const installments = rows.filter(entry => entry.deal_id === row.deal_id && entry.commission_id)
      .sort((a, b) => (a.invoiceDay ?? a.due_on ?? '9999').localeCompare(b.invoiceDay ?? b.due_on ?? '9999')
        || (a.due_on ?? '').localeCompare(b.due_on ?? '') || a.key.localeCompare(b.key));
    const installment = installments.length > 1 && row.commission_id
      ? installments.indexOf(row) + 1 : null;
    const amount = row.amount === null ? '' : invoiceMoney(row.amount);
    const due = row.due_on ? invoiceDate(row.due_on) : '';
    const invoice = installment ? `installment ${installment} invoice` : 'invoice';
    const status = row.status === 'awaiting' ? 'awaiting invoice' : row.status;
    const question = `About the ${invoice}${amount ? ` for ${amount}` : ''}${due ? ` due ${due}` : ''} (${status}): `;
    // The fragment keeps the draft's invoice facts out of HTTP requests.
    $('invoiceDocAction').href = `/doc-chats?${docParams}#${new URLSearchParams({ question })}`;
    const commissionLabel = row.status === 'paid' ? 'Paid to DoctorCRE'
      : row.status === 'awaiting' ? 'DoctorCRE commission' : 'Owed to DoctorCRE';
    paint($('invoiceDetailFacts'), `
      <div class="invoice-detail-facts">
        ${amount ? `<div><span>${commissionLabel}</span><strong>${E(amount)}</strong></div>` : ''}
        <div><span>Status</span><strong class="invoice-status-value">${statusLabel(row)}</strong></div>
        ${row.age === null ? '' : `<div><span>${row.status==='paid'?'Days to payment':'Days outstanding'}</span><strong>${row.age}</strong></div>`}
      </div>`);
    paint($('invoiceTimeline'),[['Closed',row.closed_on],['Invoiced',row.invoiceDay],['Paid',row.received_on]].map(([label,day])=>`<div class="invoice-milestone${day?' done':''}"><strong>${label}</strong>${day?`<time datetime="${day}">${invoiceDate(day)}</time>`:''}</div>`).join(''));
    $('invoiceActivity').textContent=row.status==='paid'?`Payment recorded ${invoiceDate(row.received_on)}.`:row.status==='awaiting'?'Waiting for an invoice date.':row.overdue?`Payment due ${invoiceDate(row.due_on)}.`:`Invoiced ${invoiceDate(row.invoiceDay)}.`;
    paint($('invoiceOriginalFacts'),[['Installment',installment],['Owner',ownerLabel(row.owner)],['Closed',row.closed_on && invoiceDate(row.closed_on)],['Invoiced',row.invoiceDay && invoiceDate(row.invoiceDay)],['Commission',amount],['Due',due],['Paid',row.received_on && invoiceDate(row.received_on)]].filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${E(value)}</dd>`).join(''));
    $('invoicePayment').hidden=!row.canMarkPaid;
    $('invoicePaidDate').min=row.invoiceDay || '';$('invoicePaidDate').max=today();
    const intent=invoiceStates.get(row.key)?.pending;
    const sending = intent?.readAfter === null;
    $('invoicePaidDate').disabled=Boolean(intent);
    if(intent)$('invoicePaidDate').value=intent.args.received_on;
    $('markInvoicePaid').disabled=preparingPayments.has(row.key) || sending;
    $('markInvoicePaid').textContent=intent && !sending?'Retry payment':'Mark paid';
    if(intent){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent=sending?'Confirming payment…':'Payment confirmation pending.';}
    else $('invoicePaymentNotice').hidden=true;
  }
  function openDetail(key,element) {
    selected=key;opener=element || document.activeElement;
    $('invoicePaidDate').value=today();$('invoiceOriginal').open=false;$('invoicePaymentNotice').hidden=true;
    renderDetail();$('invoiceDetail').showModal();
  }
  function returnFocus(){
    if(!selected)return;
    const key=selected;selected=null;
    const button=[...$('invoiceRows').querySelectorAll('[data-invoice]')].find(node=>node.dataset.invoice===key);
    focusVisible(button || opener);
  }
  function closeDetail(){ $('invoiceDetail').close();returnFocus(); }
  onDialogClosed($('invoiceDetail'),returnFocus);
  $('closeInvoiceDetail').addEventListener('click',closeDetail);
  $('invoiceRows').addEventListener('click',event=>{const button=event.target.closest('[data-invoice]');if(button)openDetail(button.dataset.invoice,button);});
  $('invoiceTabs').addEventListener('click',event=>{const button=event.target.closest('[data-status]');if(button){status=button.dataset.status;if(['paid','awaiting'].includes(status))age=null;render();}});
  $('invoiceAging').addEventListener('click',event=>{const button=event.target.closest('[data-age]');if(button){age=age===Number(button.dataset.age)?null:Number(button.dataset.age);status='unpaid';render();}});
  $('allAges').addEventListener('click',()=>{age=null;render();});
  $('invoiceSearch').addEventListener('input',render);$('invoiceOwner').addEventListener('change',render);
  $('clearInvoiceFilters').addEventListener('click',()=>{status='all';age=null;$('invoiceSearch').value='';$('invoiceOwner').value='';render();});
  async function refresh({signal}={}) {
    try{
      const sequence = ++readSequence;
      const next = await client.getInvoiceTracker({ signal });
      if (disposed || signal?.aborted) return;
      if (!validInvoiceTracker(next)) throw new Error('Invalid invoice snapshot');
      loadPayments(next.actor);
      applyRead(next, sequence);
      $('invoiceNotice').hidden = true;
      const owner=$('invoiceOwner').value;const owners=[...new Set([...rows.map(row=>row.owner),owner].filter(Boolean))].sort();
      const options='<option value="">Everyone</option>'+owners.map(value=>`<option value="${E(value)}">${E(ownerLabel(value))}</option>`).join('');
      if($('invoiceOwner').innerHTML!==options){$('invoiceOwner').innerHTML=options;$('invoiceOwner').value=owner;}
      render();
    }catch(error){if(disposed||signal?.aborted)return;$('invoiceNotice').hidden=false;
      const signedOut=[401,403].includes(error?.status);
      $('invoiceNotice').innerHTML=signedOut?'<a href="/auth/login?return_to=%2Finvoices">Sign in</a>':'Invoices temporarily unavailable';
      if(signedOut){snapshot=null;rows=null;invoiceStates.clear();paymentStore=null;closeDetail();render();}
      else if(!rows){$('invoiceRows').innerHTML='<p>Invoices unavailable</p>';$('invoiceRows').setAttribute('aria-busy','false');}
    }
  }
  const auto=mountAutoRefresh({document,window,refresh,intervalMs});
  $('refreshInvoices').addEventListener('click',()=>auto.refresh());
  $('invoicePayment').addEventListener('submit',async event=>{
    event.preventDefault();const row=rows?.find(row=>row.key===selected);
    if(!row?.canMarkPaid || disposed || preparingPayments.has(row.key))return;
    let intent = invoiceStates.get(row.key).pending;
    const replay = Boolean(intent);
    if (intent?.readAfter === null || (!intent && !$('invoicePayment').reportValidity())) return;
    if(!intent){
      const receivedOn=$('invoicePaidDate').value;
      preparingPayments.add(row.key);$('markInvoicePaid').disabled=true;
      let current;
      try{
        const sequence = ++readSequence;
        const next = await client.getInvoiceTracker();
        if (disposed) return;
        if (!validInvoiceTracker(next)) throw new Error('Invalid invoice snapshot');
        if(next.actor!==paymentActor){snapshot=null;rows=null;invoiceStates.clear();paymentStore=null;closeDetail();render();throw new Error('Account changed');}
        if (!snapshot || selected !== row.key) return;
        const displayedVersion = rows.find(item => item.key === row.key)?.base_version;
        applyRead(next, sequence, row.key);
        current = rows.find(item => item.key === row.key);
        render();
        if(!current?.canMarkPaid || current.base_version!==displayedVersion){
          $('invoicePaymentNotice').hidden=false;
          $('invoicePaymentNotice').textContent='Invoice changed. Review its current details before recording payment.';
          return;
        }
      }catch{
        if(!disposed){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Payment not sent. Current invoice could not be verified.';}
        return;
      }finally{preparingPayments.delete(row.key);if(!disposed && selected===row.key)$('markInvoicePaid').disabled=false;}
      intent = { args: Object.freeze({ commission_id: current.commission_id, base_version: current.base_version,
        received_on: receivedOn, idempotency_key: uuidv4() }), readAfter: null };
      const payment = invoiceStates.get(row.key);
      payment.pending = intent;
      try{savePayments();}catch{
        payment.pending=null;renderDetail();$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Payment not recorded. Recovery storage unavailable.';return;
      }
    }
    intent.readAfter = null;
    renderDetail();
    const paymentEntry = snapshot.entries.find(entry => entry.commission_id === row.key);
    let receipt,refusalMessage;
    try{receipt=await client.markInvoicePaid(intent.args);}
    catch(error){
      const code=error?.payload?.error;
      refusalMessage=paymentRefusals.get(code);
      // An offline replay says nothing about the original unanswered request.
      if(!replay&&code==='offline')refusalMessage='Payment not recorded. You are offline.';
      if(!replay&&[401,403].includes(error?.status))refusalMessage='Payment not recorded.';
    }
    if(disposed)return;
    const payment = invoiceStates.get(row.key);
    if (payment?.pending === intent) {
      if(receipt?.engine_receipt === true && receipt.ok === true && receipt.id === intent.args.commission_id
        && receipt.received_on === intent.args.received_on && Number.isSafeInteger(receipt.base_version)
        && receipt.base_version > 0 && isEarlierVersion(intent.args.base_version, receipt.base_version)
        && !isEarlierVersion(receipt.base_version, paymentEntry.base_version)
        && receipt.received_on >= paymentEntry.commission_invoiced_on){
        const paid = { ...paymentEntry, status: 'received', base_version: receipt.base_version, received_on: receipt.received_on };
        confirmPayment(payment);
        setSnapshot(withEntry(snapshot, row.key, paid));
        render();
      } else if (refusalMessage) {
        payment.pending = null;
        savePayments();
      } else {
        intent.readAfter = readSequence;
        if (selected === row.key) renderDetail();
      }
    }
    await auto.revalidate();
    if(disposed || selected!==row.key)return;
    renderDetail();
    if(refusalMessage){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent=refusalMessage;}
  });
  render();const ready=auto.refresh();
  return {ready,refresh:()=>auto.refresh(),dispose(){disposed=true;auto.dispose();}};
}
if(typeof document!=='undefined'&&document.getElementById('invoiceRows')){
  const boot=resolveDealroomBoot(window.location);
  createClient(boot.mode,boot.options).then(client=>mountInvoiceTracker({document,window,client})).catch(()=>{document.getElementById('invoiceRows').textContent='Invoices unavailable';});
}
