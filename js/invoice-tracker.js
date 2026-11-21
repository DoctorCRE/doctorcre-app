import {onDialogClosed} from './dialog-lifecycle.js';
import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, updatedLabel } from './auto-refresh.mjs';
import { localToday, isCalendarDay } from './calendar-model.js';
import { partnerName } from './task-records-model.js';
import { uuidv4 } from './uuid.js';
import { AGES, projectInvoices, invoiceSummary, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
const E=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const amountLabel = amount => amount === null ? 'Amount not recorded' : invoiceMoney(amount);
const ownerLabel = owner => partnerName(owner) || 'Unassigned';
const missingAmounts = count => count ? ` · ${count} without a recorded amount` : '';
const statusLabel=row=>row.status==='paid'?'Paid':row.status==='awaiting'?'Awaiting invoice':row.overdue?'Overdue':'Unpaid';
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
  let rows=null,status='all',age=null,selected=null,opener=null,disposed=false,updatedAt=null;
  const payments=new Map();
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
      if(!args || typeof args.commission_id!=='string' || !Number.isInteger(args.base_version) || args.base_version<1
        || !isCalendarDay(args.received_on) || typeof args.idempotency_key!=='string' || !args.idempotency_key)throw new Error('Invalid payment recovery');
      restored.set(args.commission_id,{args:Object.freeze(args),state:'uncertain'});
    }
    paymentStore=key;paymentActor=actor;payments.clear();for(const [id,intent] of restored)payments.set(id,intent);
  }
  function savePayments() {
    window.sessionStorage.setItem(paymentStore,JSON.stringify([...payments.values()].map(intent=>intent.args)));
  }
  function forgetPayment(key) {
    if(payments.delete(key))savePayments();
  }
  const requested=new URL(window.location.href).searchParams.get('invoice');
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
    $('invoiceUpdated').textContent=updatedLabel(updatedAt);
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
        <span class="row-money${row.amount === null ? ' invoice-missing-amount' : ''}">${E(amountLabel(row.amount))}</span>
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
    const dealLink=typeof row.deal_id==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.deal_id)
      ? `<a data-invoice-key="deal:${E(row.key)}" href="/deals?deal=${E(encodeURIComponent(row.deal_id))}">Open deal</a>` : '<span>Deal unavailable</span>';
    const commissionLabel = row.status === 'paid' ? 'Paid to DoctorCRE'
      : row.status === 'awaiting' ? 'DoctorCRE commission' : 'Owed to DoctorCRE';
    paint($('invoiceDetailFacts'), `
      <div class="invoice-detail-facts">
        <div><span>${commissionLabel}</span><strong class="${row.amount === null ? 'invoice-missing-amount' : ''}">${E(amountLabel(row.amount))}</strong></div>
        <div><span>Status</span><strong class="invoice-status-value">${statusLabel(row)}</strong></div>
        ${row.age === null ? '' : `<div><span>${row.status==='paid'?'Days to payment':'Days outstanding'}</span><strong>${row.age}</strong></div>`}
      </div><p>${dealLink}</p>`);
    paint($('invoiceTimeline'),[['Closed',row.closed_on],['Invoiced',row.invoiceDay],['Paid',row.received_on]].map(([label,day])=>`<div class="invoice-milestone${day?' done':''}"><strong>${label}</strong>${day?`<time datetime="${day}">${invoiceDate(day)}</time>`:''}</div>`).join(''));
    $('invoiceActivity').textContent=row.status==='paid'?`Payment recorded ${invoiceDate(row.received_on)}.`:row.status==='awaiting'?'Waiting for an invoice date.':row.overdue?`Payment due ${invoiceDate(row.due_on)}.`:`Invoiced ${invoiceDate(row.invoiceDay)}.`;
    paint($('invoiceOriginalFacts'),[['Owner',ownerLabel(row.owner)],['Closed',invoiceDate(row.closed_on)],['Invoiced',invoiceDate(row.invoiceDay)],['Commission',amountLabel(row.amount)],['Due',row.due_on?invoiceDate(row.due_on):'Due date not recorded'],['Paid',invoiceDate(row.received_on)]].map(([label,value])=>`<dt>${label}</dt><dd>${E(value)}</dd>`).join(''));
    $('invoicePayment').hidden=!row.canMarkPaid;
    $('invoicePaidDate').min=row.invoiceDay || '';$('invoicePaidDate').max=today();
    const intent=payments.get(row.key);
    $('invoicePaidDate').disabled=Boolean(intent);
    if(intent)$('invoicePaidDate').value=intent.args.received_on;
    $('markInvoicePaid').disabled=intent?.state==='sending';
    $('markInvoicePaid').textContent=intent?.state==='uncertain'?'Retry payment':'Mark paid';
    if(intent){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent=intent.state==='sending'?'Confirming payment…':'Payment confirmation pending.';}
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
      const next=await client.getInvoiceTracker({signal});const projected=projectInvoices(next,{today:today()});
      if(!projected)throw new Error('Invalid invoice snapshot');if(disposed||signal?.aborted)return;
      loadPayments(next.actor);
      for(const row of projected)if(row.status==='paid')forgetPayment(row.key);
      rows=projected;updatedAt=next.observed_at;$('invoiceNotice').hidden=true;
      const owner=$('invoiceOwner').value;const owners=[...new Set([...rows.map(row=>row.owner),owner].filter(Boolean))].sort();
      const options='<option value="">Everyone</option>'+owners.map(value=>`<option value="${E(value)}">${E(ownerLabel(value))}</option>`).join('');
      if($('invoiceOwner').innerHTML!==options){$('invoiceOwner').innerHTML=options;$('invoiceOwner').value=owner;}
      render();
    }catch(error){if(disposed||signal?.aborted)return;$('invoiceNotice').hidden=false;
      const signedOut=[401,403].includes(error?.status);
      $('invoiceNotice').innerHTML=signedOut?'<a href="/auth/login?return_to=%2Finvoices">Sign in</a>':'Invoices temporarily unavailable';
      if(signedOut){rows=null;updatedAt=null;closeDetail();render();}
      else if(!rows){$('invoiceRows').innerHTML='<p>Invoices unavailable</p>';$('invoiceRows').setAttribute('aria-busy','false');}
    }
  }
  const auto=mountAutoRefresh({document,window,refresh,intervalMs});
  $('refreshInvoices').addEventListener('click',()=>auto.refresh());
  $('invoicePayment').addEventListener('submit',async event=>{
    event.preventDefault();const row=rows?.find(row=>row.key===selected);
    if(!row?.canMarkPaid || disposed || preparingPayments.has(row.key))return;
    let intent=payments.get(row.key);
    const replay=Boolean(intent);
    if(intent?.state==='sending' || (!intent&&!$('invoicePayment').reportValidity()))return;
    if(!intent){
      const receivedOn=$('invoicePaidDate').value;
      preparingPayments.add(row.key);$('markInvoicePaid').disabled=true;
      let current;
      try{
        const next=await client.getInvoiceTracker(),projected=projectInvoices(next,{today:today()});
        if(disposed)return;
        if(!projected)throw new Error('Invalid invoice snapshot');
        if(next.actor!==paymentActor){rows=null;closeDetail();render();throw new Error('Account changed');}
        current=projected.find(item=>item.key===row.key);
        rows=projected;updatedAt=next.observed_at;render();
        if(selected!==row.key)return;
        if(!current?.canMarkPaid || current.base_version!==row.base_version){
          $('invoicePaymentNotice').hidden=false;
          $('invoicePaymentNotice').textContent='Invoice changed. Review its current details before recording payment.';
          return;
        }
      }catch{
        if(!disposed){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Payment not sent. Current invoice could not be verified.';}
        return;
      }finally{preparingPayments.delete(row.key);if(!disposed)$('markInvoicePaid').disabled=false;}
      intent={args:Object.freeze({commission_id:current.commission_id,base_version:current.base_version,received_on:receivedOn,idempotency_key:uuidv4()}),state:'sending'};
      payments.set(row.key,intent);
      try{savePayments();}catch{
        payments.delete(row.key);renderDetail();$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Payment not recorded. Recovery storage unavailable.';return;
      }
    }
    intent.state='sending';renderDetail();
    let refusalMessage;
    try{await client.markInvoicePaid(intent.args);}
    catch(error){
      const code=error?.payload?.error;
      refusalMessage=paymentRefusals.get(code);
      // An offline replay says nothing about the original unanswered request.
      if(!replay&&code==='offline')refusalMessage='Payment not recorded. You are offline.';
      if(!replay&&[401,403].includes(error?.status))refusalMessage='Payment not recorded.';
    }
    if(disposed)return;
    if(payments.get(row.key)===intent){
      if(refusalMessage)forgetPayment(row.key);
      else intent.state='uncertain';
    }
    await auto.refresh();
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
