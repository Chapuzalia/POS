import { addMonths } from '../../supabase/functions/_shared/billing/promotions.ts'
import { BillingService } from '../../supabase/functions/_shared/billing/service.ts'
import { createBillingDb, billingIds as ids } from './billing-db.mjs'

// Supabase query surface backed by real PostgreSQL, not a stub of business logic.
export function billingClient(db) {
  const identifier = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(value); return `"${value}"` }
  return {
    async rpc(name, params) {
      try { return {data:(await db.query(`select ${identifier(name)}($1,$2::jsonb) result`,[params.p_action,JSON.stringify(params.p_data)])).rows[0].result,error:null} }
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

export class FakeStripe {
  subscriptions=[]; invoices=[]; calls=[]; sessions=new Map(); schedules=new Map(); prices=new Map(); cache=new Map()
  previewRecurring=false; priceAmounts=new Map([['price_base',10000],['price_production',1000]])
  failPayment=false; offline=false; now=Math.floor(Date.now()/1000)
  async list(path) {
    if(this.offline)throw new Error('offline')
    if(path==='/subscriptions')return structuredClone(this.subscriptions)
    if(path==='/invoices')return structuredClone(this.invoices)
    if(path==='/prices')return [...this.prices.values()]
    throw new Error(path)
  }
  invoice(paid=true){const invoice={id:`in_${this.invoices.length+1}`,customer:'cus_test',status:paid?'paid':'open',currency:'eur',amount_due:10000,amount_paid:paid?10000:0,total:10000,total_excluding_tax:10000,subtotal_excluding_tax:10000,created:this.now,number:null,hosted_invoice_url:null,invoice_pdf:null,status_transitions:{paid_at:paid?this.now:null}};this.invoices.push(invoice);return invoice}
  items(lines){return lines.map((line,index)=>({id:`si_${index}`,price:{id:line.price},quantity:line.quantity,current_period_start:this.now,current_period_end:this.now+2592000}))}
  discounts(value){return value?value.map(discount=>({source:{coupon:discount.coupon}})):[]}
  completeCheckout(){const session=[...this.sessions.values()].at(-1);session.status='complete';const invoice=this.invoice();this.subscriptions=[{id:'sub_test',customer:'cus_test',livemode:false,status:'active',billing_cycle_anchor:this.now,items:{data:this.items(session.params.line_items),has_more:false},pending_update:null,cancel_at_period_end:false,latest_invoice:invoice,schedule:null,discounts:this.discounts(session.params.discounts),metadata:session.params.subscription_data.metadata}]}
  pay(){const sub=this.subscriptions[0]; if(sub.pending_update){const params=sub.pending_update;sub.items.data=this.items(params.items.filter(row=>!row.deleted));sub.discounts=this.discounts(params.discounts);sub.pending_update=null}sub.status='active';sub.latest_invoice=this.invoice()}
  advancePhase(index=1){const sub=this.subscriptions[0],schedule=this.schedules.get(sub.schedule),phase=schedule.phases[index];this.now=schedule.current_phase.end_date+(index-1)*2592000;sub.items.data=this.items(phase.items);sub.metadata={...sub.metadata,...phase.metadata};sub.discounts=this.discounts(phase.discounts);sub.latest_invoice=this.invoice()}
  applyScheduledPhase(at) {
    const sub=this.subscriptions[0], schedule=this.schedules.get(sub.schedule)
    if(!schedule?.phases)return
    const index=schedule.phases.findIndex(p=>p.start_date<=at&&at<p.end_date)
    if(index<0){if(at>=schedule.phases.at(-1).end_date){schedule.status='released';sub.schedule=null}return}
    const phase=schedule.phases[index],period=sub.items.data[0]
    const start=period.current_period_start,end=period.current_period_end
    sub.items.data=this.items(phase.items).map(item=>({...item,current_period_start:start,current_period_end:end}))
    sub.metadata={...sub.metadata,...phase.metadata};sub.discounts=this.discounts(phase.discounts)
    schedule.current_phase={start_date:phase.start_date,end_date:phase.end_date}
  }
  advanceTo(at,fail=false) {
    this.now=at; const sub=this.subscriptions[0],period=sub.items.data[0]
    const renewal=at>=period.current_period_end
    let start=period.current_period_start,end=period.current_period_end
    while(end<=at){start=end;end=addMonths(end,1)}
    sub.items.data.forEach(item=>{item.current_period_start=start;item.current_period_end=end})
    this.applyScheduledPhase(at)
    if(renewal){sub.latest_invoice=this.invoice(!fail);sub.status=fail?'past_due':'active'}
  }
  async request(method,path,params={},idempotencyKey){
    this.calls.push({method,path,params:structuredClone(params),idempotencyKey})
    if(this.offline)throw new Error('offline')
    const cacheKey=`${method}:${path}:${idempotencyKey}`
    if(idempotencyKey&&this.cache.has(cacheKey))return structuredClone(this.cache.get(cacheKey))
    let result
    if(path==='/invoices/create_preview')result={amount_due:this.previewRecurring&&params.preview_mode==='recurring'?params.subscription_details.items.filter(item=>!item.deleted).reduce((sum,item)=>sum+(this.priceAmounts.get(item.price)??0)*item.quantity,0):500,currency:'eur'}
    else if(path==='/customers')result={id:'cus_test'}
    else if(path==='/checkout/sessions'){result={id:`cs_test_${this.sessions.size}`,url:'https://checkout.stripe.com/test'};this.sessions.set(result.id,{...result,status:'open',params})}
    else if(path.startsWith('/checkout/sessions/'))result=this.sessions.get(path.split('/').at(-1))
    else if(path==='/subscription_schedules'){result={id:'sub_sched_test',current_phase:{start_date:this.subscriptions[0].items.data[0].current_period_start,end_date:this.subscriptions[0].items.data[0].current_period_end}};this.subscriptions[0].schedule=result.id;this.schedules.set(result.id,result)}
    else if(path.startsWith('/subscription_schedules/')){
      if(path.endsWith('/release')){result=this.schedules.get(path.split('/').at(-2));result.status='released';this.subscriptions[0].schedule=null}
      else {result=this.schedules.get(path.split('/').at(-1));Object.assign(result,params);if(params.metadata){result.subscription='sub_test';result.status='active';this.applyScheduledPhase(this.now)}}
    }
    else if(path==='/subscriptions/sub_test'){
      const sub=this.subscriptions[0]
      if(method==='DELETE')sub.status='canceled'
      else if(method==='POST'&&params.cancel_at_period_end)sub.cancel_at_period_end=true
      else if(method==='POST'){
        if(this.failPayment){sub.pending_update=params;sub.latest_invoice=this.invoice(false)}
        else{sub.items.data=this.items(params.items.filter(row=>!row.deleted));sub.discounts=this.discounts(params.discounts);sub.latest_invoice=this.invoice()}
      }
      result=sub
    }else if(path.startsWith('/coupons/'))result={id:path.split('/').at(-1),percent_off:Number(path.split('_').at(-1))/100,amount_off:null,duration:'forever',valid:true}
    else if(path==='/prices'){result={id:`price_custom_${this.prices.size}`,unit_amount:params.unit_amount,currency:params.currency,recurring:params.recurring,metadata:params.metadata,active:true};this.prices.set(result.id,result)}
    else if(path.startsWith('/products/'))result={id:path.split('/').at(-1)}
    else throw new Error(`Unhandled Stripe ${method} ${path}`)
    if(idempotencyKey)this.cache.set(cacheKey,structuredClone(result))
    return structuredClone(result)
  }
}
export async function createBillingService(t) {
  const {db,transition}=await createBillingDb(t)
  const base=await transition('catalog_save',{actorId:ids.owner,product:{key:'base',kind:'plan',name:'Synthetic base',description:'',scope:'tenant',featureKey:null,resource:null,active:true,sortOrder:0},version:{interval:'month',amountCents:10000,features:['restaurant'],limits:{venues:3,devices:5},included:{},maximum:null,requires:[]},reason:'Test fixture'})
  // The migration seeds a production addon draft, without price assumptions.
  const production=await transition('catalog_save',{actorId:ids.owner,product:{key:'production',kind:'addon',name:'Production',description:'',scope:'venue',featureKey:'production',resource:null,active:true,sortOrder:1},version:{interval:'month',amountCents:1000,features:[],limits:{venues:1,devices:0},included:{},maximum:10,requires:['restaurant']},reason:'Test fixture'})
  await db.query('update billing_price_versions set stripe_price_id=$1,published=true where id=$2',['price_base',base.id])
  await db.query('update billing_price_versions set stripe_price_id=$1,published=true where id=$2',['price_production',production.id])
  const stripe=new FakeStripe(),service=new BillingService(billingClient(db),stripe,'http://localhost:5173','bpc_test')
  const selection={planVersionId:base.id,addons:[]}
  const activate=async()=>{const quote=await service.quote(ids.tenant,ids.owner,selection,null,'Test onboarding');await service.confirm(ids.tenant,ids.owner,quote.id);stripe.completeCheckout();await service.reconcile(ids.tenant)}
  return {db,stripe,service,selection,base,production,activate,transition}
}
