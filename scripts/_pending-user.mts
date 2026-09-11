import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
const email = 'pending-probe.0911@resumerai-probe.dev';
if (process.argv.includes('--delete')) {
  const gone = await db.delete(users).where(eq(users.email, email)).returning({ id: users.id });
  console.log('deleted', gone.length);
} else {
  await db.insert(users).values({ email, name: 'Pending Probe', emailVerified: new Date(), passwordHash: await hashPassword('pending probe 0911 resumer') });
  const [u] = await db.select({ approval: users.approval }).from(users).where(eq(users.email, email));
  console.log('created with approval =', u.approval);
}
process.exit(0);
