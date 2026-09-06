/**
 * One consistent snapshot of what the last sync produced.
 *
 * Everything here is read inside a single transaction, so the numbers cannot drift
 * between queries — which they did when this was several separate scripts.
 */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

await sql.begin(async (tx) => {
  const [u] = await tx<{ id: string }[]>`select id from "user" limit 1`;

  console.log('by type:', await tx`
    select type, count(*)::int as n,
           count(*) filter (where flagged_for_removal)::int as flagged
    from profile_record where user_id = ${u.id} group by type order by 1`);

  console.log('totals:', await tx`
    select (select count(*)::int from profile_record where user_id = ${u.id}) as records,
           (select count(*)::int from role where user_id = ${u.id}) as roles,
           (select count(*)::int from contact_info where user_id = ${u.id}) as contact`);

  console.log('bullets linked to a real role row:', await tx`
    select count(*)::int as linked,
           (select count(*)::int from profile_record
            where user_id = ${u.id} and type = 'experience-bullet') as total
    from profile_record p
    where p.user_id = ${u.id} and p.type = 'experience-bullet'
      and exists (select 1 from role r where r.id = p.data->>'roleId')`);

  console.log('contact:', await tx`
    select full_name, email, location, portfolio_url, github_url, linkedin_url
    from contact_info where user_id = ${u.id}`);

  console.log('last sync:', await tx`
    select last_synced_sha, last_synced_at from "user" where id = ${u.id}`);
});

await sql.end();
