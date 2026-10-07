/** Display formats for India: en-IN, Asia/Kolkata. Server components have no idea of the reader's zone, so this names it. */

const TZ = 'Asia/Kolkata';
const asDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

export const formatDate = (d: Date | string | number): string =>
  asDate(d).toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });

export const formatDateTime = (d: Date | string | number): string =>
  `${asDate(d).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST`;

export const formatInr = (amount: number, opts: { decimals?: number } = {}): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: opts.decimals ?? 0,
    maximumFractionDigits: opts.decimals ?? 0,
  }).format(amount);
