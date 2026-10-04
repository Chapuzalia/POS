import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261004190253_optimize_ticket_line_cost_snapshot.sql', import.meta.url), 'utf8')

async function fixture(t, withFinal = true) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create table ticket_lines(id integer primary key, tenant_id integer, component_cents integer, theoretical_cost_known boolean, theoretical_cost_cents integer);
    create table test_calls(kind text);
    create table captured_components(line_id integer, cents integer);
    create function set_ticket_line_theoretical_cost() returns trigger language plpgsql as $$begin return new; end$$;
    create function snapshot_ticket_line_theoretical_cost() returns trigger language plpgsql as $$begin return new; end$$;
    create function theoretical_variant_cost() returns jsonb language plpgsql as $$begin raise exception 'Duplicate provisional cost executed'; end$$;
    create function theoretical_ticket_line_cost(line_id integer) returns jsonb language plpgsql as $$
      declare amount integer;
      begin
        insert into public.test_calls values('final_cost');
        select cents into amount from public.captured_components where captured_components.line_id=$1;
        return jsonb_build_object('known',amount is not null,'cost',amount::numeric/100);
      end$$;
    create function capture_components() returns trigger language plpgsql as $$begin
      insert into captured_components values(new.id,new.component_cents); return new;
    end$$;
    create function observe_update() returns trigger language plpgsql as $$begin
      insert into public.test_calls values('update'); return new;
    end$$;
    create trigger set_cost before insert or update on ticket_lines for each row execute function set_ticket_line_theoretical_cost();
    create trigger capture_components after insert on ticket_lines for each row execute function capture_components();
    create trigger observe_update after update on ticket_lines for each row execute function observe_update();
  `)
  if (withFinal) await db.exec('create trigger zz_set_ticket_line_theoretical_cost_after_components after insert on ticket_lines for each row execute function snapshot_ticket_line_theoretical_cost();')
  return db
}

test('cost optimization migration preserves deployed contracts and requires the final trigger', async t => {
  assert.deepEqual(analyzeMigration(migration), [])
  const db = await fixture(t, false)
  await assert.rejects(db.exec(migration), /division by zero/)
})

test('cost is calculated once from captured components and cannot be supplied by a client', async t => {
  const db = await fixture(t)
  await db.exec(migration)
  await db.exec('insert into ticket_lines values(1,10,137,true,9999)')
  assert.deepEqual((await db.query('select theoretical_cost_known,theoretical_cost_cents from ticket_lines')).rows,
    [{ theoretical_cost_known: true, theoretical_cost_cents: 137 }])
  assert.deepEqual((await db.query('select kind from test_calls order by kind')).rows, [{ kind: 'final_cost' }, { kind: 'update' }])
  await db.exec('update ticket_lines set theoretical_cost_known=false,theoretical_cost_cents=9999 where id=1')
  assert.equal((await db.query('select theoretical_cost_cents from ticket_lines')).rows[0].theoretical_cost_cents, 137)
  assert.equal((await db.query("select count(*)::integer n from test_calls where kind='final_cost'")).rows[0].n, 1)
})

test('unknown cost avoids a redundant update while known zero is retained', async t => {
  const db = await fixture(t)
  await db.exec(migration)
  await db.exec('insert into ticket_lines values(1,10,null,true,9999)')
  assert.deepEqual((await db.query('select theoretical_cost_known,theoretical_cost_cents from ticket_lines')).rows,
    [{ theoretical_cost_known: false, theoretical_cost_cents: null }])
  assert.deepEqual((await db.query('select kind from test_calls')).rows, [{ kind: 'final_cost' }])
  await db.exec('insert into ticket_lines values(2,10,0,false,null)')
  assert.deepEqual((await db.query('select theoretical_cost_known,theoretical_cost_cents from ticket_lines where id=2')).rows,
    [{ theoretical_cost_known: true, theoretical_cost_cents: 0 }])
})

test('failure calculating the final snapshot rolls back the line and its captured components', async t => {
  const db = await fixture(t)
  await db.exec(migration)
  await db.exec("create or replace function theoretical_ticket_line_cost(line_id integer) returns jsonb language plpgsql as $$begin raise exception 'COST_FAILED'; end$$;")
  await assert.rejects(db.exec('insert into ticket_lines values(1,10,137,false,null)'), /COST_FAILED/)
  assert.equal((await db.query('select count(*)::integer n from ticket_lines')).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::integer n from captured_components')).rows[0].n, 0)
})
