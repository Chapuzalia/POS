import { addMonths } from '../../supabase/functions/_shared/billing/promotions.ts'
import { MollieRequestError } from '../../supabase/functions/_shared/billing/mollie.ts'
import { BillingService } from '../../supabase/functions/_shared/billing/service.ts'
import { createBillingDb, billingIds as ids } from './billing-db.mjs'

// Supabase query surface backed by real PostgreSQL, not a stub of business logic.
export function billingClient(db) {
  const identifier = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(value); return `"${value}"` }
  return {
    async rpc(name, params) {
      try { return {data:(await db.query(`select ${identifier(name)}($1,$2::jsonb) result`,name==='billing_save_onboarding'?[params.p_tenant_id,JSON.stringify(params.p_contract)]:name==='billing_save_profile'?[params.p_tenant_id,JSON.stringify(params.p_data)]:[params.p_action,JSON.stringify(params.p_data)])).rows[0].result,error:null} }
      catch(error) {return {data:null,error:{code:error.code,message:error.message}}}
    },
    from(table) {
      let columns='*', filters=[], ordering=[], size=null,offset=0, mutation=null, options={}, one=false, maybe=false
      const args=[]
      const bind=value=>{args.push(value!==null&&typeof value==='object'?JSON.stringify(value):value);return `$${args.length}`}
      const query={
        select(value='*'){columns=value;return this},
        eq(key,value){filters.push(`${identifier(key)}=${bind(value)}`);return this},
        in(key,values){filters.push(`${identifier(key)} in (${values.map(bind).join(',')})`);return this},
        gte(key,value){filters.push(`${identifier(key)}>=${bind(value)}`);return this},
        not(key,operation,value){if(operation!=='is'||value!==null)throw new Error('unsupported');filters.push(`${identifier(key)} is not null`);return this},
        order(key,config={}){ordering.push(`${identifier(key)} ${config.ascending===false?'desc':'asc'} ${config.nullsFirst?'nulls first':'nulls last'}`);return this},
        limit(value){size=value;return this},range(start,end){offset=start;size=end-start+1;return this},returns(){return this},
        single(){one=true;return this},maybeSingle(){one=true;maybe=true;return this},
        upsert(value,config={}){mutation={type:'upsert',value};options=config;return this},
        update(value){mutation={type:'update',value};return this},
        insert(value){mutation={type:'insert',value};return this},
        async then(resolve,reject) {
          try {
            let sql
            if(mutation){
              const keys=Object.keys(mutation.value)
              if(mutation.type==='upsert'){
                const primary=options.onConflict??({billing_invoices:'stripe_invoice_id',billing_accounts:'tenant_id'}[table])
                sql=`insert into ${identifier(table)} (${keys.map(identifier).join(',')}) values (${keys.map(key=>bind(mutation.value[key])).join(',')}) on conflict (${identifier(primary)}) `
                sql+=options.ignoreDuplicates?'do nothing':`do update set ${keys.filter(key=>key!==primary).map(key=>`${identifier(key)}=excluded.${identifier(key)}`).join(',')}`
              }else if(mutation.type==='insert')sql=`insert into ${identifier(table)} (${keys.map(identifier).join(',')}) values (${keys.map(key=>bind(mutation.value[key])).join(',')})`
              else sql=`update ${identifier(table)} set ${keys.map(key=>`${identifier(key)}=${bind(mutation.value[key])}`).join(',')}`
            }else sql=`select ${columns==='*'?'*':columns.split(',').map(identifier).join(',')} from ${identifier(table)}`
            if(filters.length)sql+=` where ${filters.join(' and ')}`
            if(ordering.length)sql+=` order by ${ordering.join(',')}`
            if(size!==null)sql+=` limit ${size} offset ${offset}`
            const {rows}=await db.query(sql,args)
            resolve({data:one?(rows[0]??null):rows,error:one&&!maybe&&!rows.length?{code:'PGRST116'}:null})
          }catch(error){if(reject)resolve({data:null,error:{code:error.code,message:error.message}});else throw error}
        },
      }
      return query
    },
  }
}

const iso=()=>new Date().toISOString()
const day=seconds=>new Date(seconds*1000).toISOString().slice(0,10)
const epoch=date=>Math.floor(Date.parse(date)/1000)

// In-memory Mollie test account: the HTTP surface the service uses, with real idempotency keys.
export class FakeMollie {
  mode='test'
  customers=new Map(); mandates=[]; payments=[]; subscriptions=[]; calls=[]; cache=new Map(); offline=false; seq=0
  id(prefix){return `${prefix}_${String(++this.seq).padStart(6,'0')}`}
  async list(path,key){
    this.calls.push({method:'LIST',path})
    if(this.offline)throw new Error('offline')
    const customer=path.split('/')[2]
    const rows={payments:this.payments,subscriptions:this.subscriptions,mandates:this.mandates}[key].filter(row=>row.customerId===customer)
    return structuredClone(rows)
  }
  async request(method,path,body,key){
    this.calls.push({method,path,body:structuredClone(body),key})
    if(this.offline)throw new Error('offline')
    const cacheKey=`${method}:${path}:${key}`
    if(key&&this.cache.has(cacheKey))return structuredClone(this.cache.get(cacheKey))
    const parts=path.split('?')[0].split('/').filter(Boolean)
    let result
    if(parts[0]==='customers'&&parts.length===1){result={id:'cst_test',mode:'test',name:body.name,email:body.email,metadata:body.metadata};this.customers.set(result.id,result)}
    else if(parts[0]==='customers'&&parts.length===2){result=this.customers.get(parts[1]);if(!result)throw new MollieRequestError(404,null);if(method==='DELETE'){this.customers.delete(parts[1]);result=null}}
    else if(parts[2]==='mandates'&&parts.length===4){
      result=this.mandates.find(row=>row.id===parts[3]&&row.customerId===parts[1])
      if(!result)throw new MollieRequestError(404,null)
      if(method==='DELETE'){result.status='invalid';result=null}
    }else if(parts[2]==='mandates'){
      result={id:this.id('mdt'),mode:'test',status:'valid',method:body.method,mandateReference:body.mandateReference,customerId:parts[1],details:{consumerName:body.consumerName,consumerAccount:body.consumerAccount}}
      this.mandates.push(result)
    }else if(parts[2]==='subscriptions'&&parts.length===3){
      result={id:this.id('sub'),mode:'test',status:'active',amount:body.amount,interval:body.interval,startDate:body.startDate,nextPaymentDate:body.startDate,mandateId:body.mandateId,customerId:parts[1],description:body.description,metadata:body.metadata,webhookUrl:body.webhookUrl}
      this.subscriptions.push(result)
    }else if(parts[2]==='subscriptions'){
      result=this.subscriptions.find(row=>row.id===parts[3]&&row.customerId===parts[1])
      if(!result)throw new MollieRequestError(404,null)
      if(method==='PATCH'){if(result.status==='canceled')throw new MollieRequestError(422,'status');Object.assign(result,body)}
      if(method==='DELETE'){if(result.status==='canceled')throw new MollieRequestError(422,'status');result.status='canceled';result.canceledAt=iso();result.nextPaymentDate=null}
    }else if(parts[0]==='payments'&&parts.length===1){
      const mandate=this.mandates.find(row=>row.id===body.mandateId)
      const recurring=body.sequenceType==='recurring'
      const sepa=mandate?.method==='directdebit'
      result={id:this.id('tr'),mode:'test',status:recurring?(sepa?'pending':'paid'):'open',amount:body.amount,amountChargedBack:null,customerId:body.customerId,subscriptionId:null,mandateId:body.mandateId??null,sequenceType:body.sequenceType??'oneoff',method:recurring?mandate?.method??'creditcard':body.method??null,description:body.description,createdAt:iso(),paidAt:recurring&&!sepa?iso():null,metadata:body.metadata,_links:{checkout:recurring?null:{href:`https://www.mollie.com/checkout/test-mode?payment=${this.seq}`}}}
      this.payments.push(result)
    }else if(parts[0]==='payments'){
      result=this.payments.find(row=>row.id===parts[1])
      if(!result)throw new MollieRequestError(404,null)
      if(method==='DELETE'){if(result.method==='creditcard'&&result.status==='open'&&!this.cancelableCards)throw new MollieRequestError(422,null);result.status='canceled'}
    }else throw new Error(`Unhandled Mollie ${method} ${path}`)
    if(key)this.cache.set(cacheKey,structuredClone(result))
    return structuredClone(result)
  }
  payment(kind){return this.payments.filter(row=>row.metadata?.tickit_kind===kind).at(-1)}
  // The customer completes Mollie Checkout with a card; Mollie also creates a card mandate.
  payFirst(status='paid'){
    const payment=this.payment('first')
    payment.status=status
    if(status==='paid'){payment.paidAt=iso();payment.method='creditcard';const card={id:this.id('mdt'),mode:'test',status:'valid',method:'creditcard',mandateReference:null,customerId:payment.customerId};this.mandates.push(card);payment.mandateId=card.id}
    return payment
  }
  settle(payment,status='paid'){const row=this.payments.find(item=>item.id===payment.id);row.status=status;if(status==='paid')row.paidAt=iso();return row}
  chargeBack(payment){const row=this.payments.find(item=>item.id===payment.id);row.amountChargedBack=row.amount;return row}
  // Mollie creates the charge on nextPaymentDate from the subscription's mandate.
  renew(status='pending'){
    const sub=this.subscriptions.find(row=>row.status==='active')
    const mandate=this.mandates.find(row=>row.id===sub.mandateId)
    const payment={id:this.id('tr'),mode:'test',status,amount:sub.amount,amountChargedBack:null,customerId:sub.customerId,subscriptionId:sub.id,mandateId:sub.mandateId,sequenceType:'recurring',method:mandate?.method??'directdebit',description:sub.description,createdAt:new Date(sub.nextPaymentDate).toISOString(),paidAt:status==='paid'?iso():null,metadata:sub.metadata,_links:{checkout:null}}
    this.payments.push(payment)
    sub.nextPaymentDate=day(addMonths(epoch(sub.nextPaymentDate),sub.interval==='12 months'?12:1))
    return payment
  }
}
export const sepa={accountHolder:'Restaurante Prueba SL',iban:'ES91 2100 0418 4502 0005 1332'}
export const payer={legalName:'Restaurante Prueba SL',taxId:'B12345678',email:'billing@example.test',address:{street:'Calle Mayor 1',postalCode:'28001',city:'Madrid',province:'Madrid',countryCode:'ES'}}
export async function createBillingService(t,baseAmountCents=10000,{odoo=null}={}) {
  const {db,transition}=await createBillingDb(t)
  const base=await transition('catalog_save',{actorId:ids.owner,product:{key:'base',kind:'plan',name:'Synthetic base',description:'',scope:'tenant',featureKey:null,resource:null,active:true,sortOrder:0},version:{interval:'month',amountCents:baseAmountCents,features:['restaurant'],limits:{venues:3,devices:5},included:{},maximum:null,requires:[]},reason:'Test fixture'})
  const production=await transition('catalog_save',{actorId:ids.owner,product:{key:'production',kind:'addon',name:'Production',description:'',scope:'venue',featureKey:'production',resource:null,active:true,sortOrder:1},version:{interval:'month',amountCents:1000,features:[],limits:{venues:1,devices:0},included:{},maximum:10,requires:['restaurant']},reason:'Test fixture'})
  const mollie=new FakeMollie(),service=new BillingService(billingClient(db),mollie,'http://localhost:5173','https://hooks.example.test/billing-webhook',odoo)
  await service.publish(base.id); await service.publish(production.id)
  const selection={planVersionId:base.id,addons:[]}
  const activate=async()=>{const quote=await service.quote(ids.tenant,ids.owner,selection,null,'Test onboarding');await service.confirm(ids.tenant,ids.owner,quote.id,false,{sepa,payer});mollie.payFirst();await service.reconcile(ids.tenant)}
  return {db,mollie,service,selection,base,production,activate,transition}
}

// In-memory Odoo 19 (JSON-2 surface used by odoo-sync): partners, sale orders, invoices, payments, credit notes.
export class FakeOdoo {
  partners=[]; orders=[]; moves=[]; lines=[]; wizards=new Map(); calls=[]; emails=[]; stickyEmail=false; offline=false; totalOffsetCents=0; seq=0; invoiceSeq=0
  reports=[{id:801,report_name:'tickit.report_subscription_invoice',model:'account.move',is_invoice_report:true}]
  products=[{id:501,default_code:'TICKIT-SUB'}]; journals=[{id:601,code:'MOLL',type:'bank'}]; countries=[{id:68,code:'ES'},{id:75,code:'FR'}]; states=[{id:701,country_id:68,name:'Madrid'}]
  id(){return ++this.seq}
  match(row,domain=[]){return domain.every(([field,op,value])=>op==='in'?value.includes(row[field]):op==='=ilike'?String(row[field]).toLowerCase()===String(value).toLowerCase():row[field]===value)}
  table(model){return {'res.partner':this.partners,'sale.order':this.orders,'account.move':this.moves,'account.move.line':this.lines,'product.product':this.products,'account.journal':this.journals,'res.country':this.countries,'res.country.state':this.states,'ir.actions.report':this.reports}[model]}
  pick(row,fields){return fields?Object.fromEntries(['id',...fields].map(key=>[key,row[key]])):{...row}}
  amounts(order){const untaxed=order.lines.reduce((sum,line)=>sum+Math.round(line.price_unit*100)*line.product_uom_qty,0);return {untaxed,total:untaxed+Math.round(untaxed*21/100)+this.totalOffsetCents}}
  async call(model,method,params){
    this.calls.push({model,method,params:structuredClone(params)})
    this.onCall?.(model,method)
    if(this.offline){const{OdooRequestError}=await import('../../supabase/functions/_shared/billing/odoo.ts');throw new OdooRequestError('ODOO_UNAVAILABLE')}
    const ids=params.ids??[],active=params.context?.active_ids??[]
    // Like Odoo 19: Send & Print defaults to email; only a write can uncheck it (stickyEmail simulates one that cannot).
    if(model==='account.move.send.wizard'){
      const view=wizard=>({id:wizard.id,move_id:wizard.move_id,sending_method_checkboxes:structuredClone(wizard.checkboxes),sending_methods:Object.entries(wizard.checkboxes).filter(([,box])=>box.checked).map(([key])=>key).length?Object.entries(wizard.checkboxes).filter(([,box])=>box.checked).map(([key])=>key):false})
      if(method==='create')return params.vals_list.map(vals=>{const id=this.id();this.wizards.set(id,{id,model,move_id:vals.move_id,reportId:vals.pdf_report_id,checkboxes:{email:{label:'by Email',checked:true},snailmail:{label:'by Post',checked:false}}});return id})
      if(method==='write'){for(const id of ids)if(!this.stickyEmail)this.wizards.get(id).checkboxes=structuredClone(params.vals.sending_method_checkboxes);return true}
      if(method==='read')return ids.map(id=>view(this.wizards.get(id)))
      if(method==='action_send_and_print'){for(const id of ids){const wizard=this.wizards.get(id),move=this.moves.find(row=>row.id===wizard.move_id);if(view(wizard).sending_methods)this.emails.push(move.name);move.pdfReportId=wizard.reportId;move.invoice_pdf_report_id=[this.id(),`${move.name.replace(/\//g,'_')}.pdf`];move.is_move_sent=true}return {type:'ir.actions.act_url'}}
    }
    if(model==='account.move.line'&&method==='write'){for(const line of this.lines.filter(row=>ids.includes(row.id)))Object.assign(line,params.vals);return true}
    if(method==='search_read')return structuredClone(this.table(model).filter(row=>this.match(row,params.domain)).slice(0,params.limit??undefined).map(row=>this.pick(row,params.fields)))
    if(method==='read')return structuredClone(this.table(model).filter(row=>ids.includes(row.id)).map(row=>this.pick(row,params.fields)))
    if(method==='create'){
      return params.vals_list.map(vals=>{
        const id=this.id()
        if(model==='res.partner')this.partners.push({id,...vals})
        else if(model==='sale.order')this.orders.push({id,state:'draft',invoice_ids:[],partner_id:vals.partner_id,client_order_ref:vals.client_order_ref,origin:vals.origin,lines:vals.order_line.map(([,,line])=>line)})
        else this.wizards.set(id,{model,vals,active})
        return id
      })
    }
    if(method==='get_portal_url')return model==='sale.order'?`/my/orders/${ids[0]}?access_token=tok${ids[0]}&report_type=pdf&download=true`:`/my/invoices/${ids[0]}?access_token=tok${ids[0]}&report_type=pdf&download=true`
    if(model==='sale.order'&&method==='action_confirm'){for(const order of this.orders.filter(row=>ids.includes(row.id)))order.state='sale';return true}
    // Like Odoo: a confirmed order opens the sale.order.cancel wizard unless the warning is disabled.
    if(model==='sale.order'&&method==='action_cancel'){for(const order of this.orders.filter(row=>ids.includes(row.id))){if(!['draft','sent'].includes(order.state)&&!params.context?.disable_cancel_warning)return {type:'ir.actions.act_window',res_model:'sale.order.cancel'};order.state='cancel'}return true}
    if(model==='sale.advance.payment.inv'&&method==='create_invoices'){
      const wizard=this.wizards.get(ids[0]),order=this.orders.find(row=>row.id===wizard.vals.sale_order_ids[0][2][0])
      if(order.state!=='sale')throw new Error('order not confirmed')
      const {untaxed,total}=this.amounts(order),id=this.id()
      this.moves.push({id,move_type:'out_invoice',state:'draft',name:'/',invoice_pdf_report_id:false,partner_id:order.partner_id,amount_untaxed:untaxed/100,amount_total:total/100,payment_state:'not_paid',reversed_entry_id:false,invoice_origin:order.client_order_ref})
      for(const line of order.lines)this.lines.push({id:this.id(),move_id:id,product_id:line.product_id,name:'[TICKIT-SUB] Suscripción Tickit POS\n'+line.name})
      order.invoice_ids.push(id)
      return {type:'ir.actions.act_window'}
    }
    if(model==='account.move'&&method==='action_post'){for(const move of this.moves.filter(row=>ids.includes(row.id))){move.state='posted';if(move.name==='/')move.name=`${move.move_type==='out_refund'?'RINV':'INV'}/2026/${String(++this.invoiceSeq).padStart(5,'0')}`}return true}
    if(model==='account.payment.register'&&method==='action_create_payments'){const wizard=this.wizards.get(ids[0]);for(const move of this.moves.filter(row=>wizard.active.includes(row.id))){if(move.state!=='posted')throw new Error('draft');move.payment_state='paid';move.payment={...wizard.vals}}return true}
    if(model==='account.move.reversal'&&method==='refund_moves'){
      const wizard=this.wizards.get(ids[0])
      for(const origin of this.moves.filter(row=>wizard.active.includes(row.id)))this.moves.push({id:this.id(),move_type:'out_refund',state:'draft',name:'/',invoice_pdf_report_id:false,partner_id:origin.partner_id,amount_untaxed:origin.amount_untaxed,amount_total:origin.amount_total,payment_state:'not_paid',reversed_entry_id:origin.id,ref:wizard.vals.reason})
      return {type:'ir.actions.act_window'}
    }
    throw new Error(`Unhandled Odoo ${model}.${method}`)
  }
  async pdf(path){if(this.offline)throw new Error('offline');this.calls.push({pdf:path});return new TextEncoder().encode(`%PDF-1.7 ${path}`)}
  creates(model){return this.calls.filter(call=>call.model===model&&call.method==='create').length}
}
