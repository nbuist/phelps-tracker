// Supabase project settings. Both values are public by design: the database's Row Level
// Security rules (schema.sql) are what keep each student's diary private.
// NEVER put the service_role / secret key here.
// Leave them empty to run the app without accounts (diary stays on this device only).
window.PHELPS_CONFIG = {
  supabaseUrl: "https://jbtrrtwovjizkxwxdkll.supabase.co",
  supabaseKey: "sb_publishable_nPRVJd6B25J0v758VIkRPQ_nwasWcTt", // the "publishable" (or legacy "anon") key
};
