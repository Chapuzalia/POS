import { addMonths } from '../../supabase/functions/_shared/billing/promotions.ts'
import { MollieRequestError } from '../../supabase/functions/_shared/billing/mollie.ts'
import { BillingService } from '../../supabase/functions/_shared/billing/service.ts'
import { createBillingDb, billingIds as ids } from './billing-db.mjs'

// Supabase query surface backed by real PostgreSQL, not a stub of business logic.
export function billingClient(db) {
  const identifier = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(value); return `"${value}"` }
  return {
    async rpc(name, params) {
      try { return {data:(await db.query(`select ${identifier(name)}($1,$2::jsonb) result`,name==='billing_save_onboarding'?[params.p_tenant_id,JSON.stringify(params.p_contract)]:[params.p_action,JSON.stringify(params.p_data)])).rows[0].result,error:null} }
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
        async then(resolve,reject) {
          try {
            let sql
            if(mutation){
              const keys=Object.keys(mutation.value)
              if(mutation.type==='upsert'){
                const primary=options.onConflict??({billing_invoices:'stripe_invoice_id',billing_accounts:'tenant_id'}[table])
                sql=`insert into ${identifier(table)} (${keys.map(identifier).join(',')}) values (${keys.map(key=>bind(mutation.value[key])).join(',')}) on conflict (${identifier(primary)}) `
                sql+=options.ignoreDuplicates?'do nothing':`do update set ${keys.filter(key=>key!==primary).map(key=>`${identifier(key)}=excluded.${identifier(key)}`).join(',')}`
              }else sql=`update ${identifier(table)} set ${keys.map(key=>`${identifier(key)}=${bind(mutation.value[key])}`).join(',')}`
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
    else if(parts[2]==='mandates'){
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
    const payment={id:this.id('tr'),mode:'test',status,amount:sub.amount,amountChargedBack:null,customerId:sub.customerId,subscriptionId:sub.id,mandateId:sub.mandateId,sequenceType:'recurring',method:mandate?.method??'directdebit',description:sub.description,createdAt:iso(),paidAt:status==='paid'?iso():null,metadata:sub.metadata,_links:{checkout:null}}
    this.payments.push(payment)
    sub.nextPaymentDate=day(addMonths(epoch(sub.nextPaymentDate),sub.interval==='12 months'?12:1))
    return payment
  }
}
export const sepa={accountHolder:'Restaurante Prueba SL',iban:'ES91 2100 0418 4502 0005 1332'}
export const payer={legalName:'Restaurante Prueba SL',taxId:'B12345678'}
export async function createBillingService(t,baseAmountCents=10000) {
  const {db,transition}=await createBillingDb(t)
  const base=await transition('catalog_save',{actorId:ids.owner,product:{key:'base',kind:'plan',name:'Synthetic base',description:'',scope:'tenant',featureKey:null,resource:null,active:true,sortOrder:0},version:{interval:'month',amountCents:baseAmountCents,features:['restaurant'],limits:{venues:3,devices:5},included:{},maximum:null,requires:[]},reason:'Test fixture'})
  const production=await transition('catalog_save',{actorId:ids.owner,product:{key:'production',kind:'addon',name:'Production',description:'',scope:'venue',featureKey:'production',resource:null,active:true,sortOrder:1},version:{interval:'month',amountCents:1000,features:[],limits:{venues:1,devices:0},included:{},maximum:10,requires:['restaurant']},reason:'Test fixture'})
  const mollie=new FakeMollie(),service=new BillingService(billingClient(db),mollie,'http://localhost:5173','https://hooks.example.test/billing-webhook')
  await service.publish(base.id); await service.publish(production.id)
  const selection={planVersionId:base.id,addons:[]}
  const activate=async()=>{const quote=await service.quote(ids.tenant,ids.owner,selection,null,'Test onboarding');await service.confirm(ids.tenant,ids.owner,quote.id,false,{sepa,payer});mollie.payFirst();await service.reconcile(ids.tenant)}
  return {db,mollie,service,selection,base,production,activate,transition}
}
