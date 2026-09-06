// No-op stand-in for the `server-only` guard when running verification scripts
// directly under tsx. The real package throws outside a Server Component context,
// which is correct in the app and unhelpful in a test harness.
export {};
