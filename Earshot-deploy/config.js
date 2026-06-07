// config.js — paste your Supabase project values here, then reload the app.
// Find both at: Supabase dashboard → Project Settings → API.
// Leaving these blank keeps Earshot in local-only mode (records + plays on this device, no sync).
//
// The anon key is PUBLIC by design — it's safe to ship in client code. Your data is protected
// by Row-Level Security (see supabase/schema.sql), not by hiding this key.

export const SUPABASE_URL = 'https://vvsztkcxiavyrhsxdasd.supabase.co';   // base URL only — no /rest/v1/
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2c3p0a2N4aWF2eXJoc3hkYXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2OTk0NjQsImV4cCI6MjA5NjI3NTQ2NH0.S7lyyWQZeGT8DuXDbtwN5Jy-DIHkeORSr-XWskmz-SU';

// For push notifications — your VAPID *public* key (safe to ship; private key is in ~/Documents/earshot-SECRETS.txt).
export const VAPID_PUBLIC_KEY = 'BMNkWJRxm-yP2j6Eo89EacGD9q3QCjSSeTnTWPD2GZsUCdI0jchflfh4meFWks6MhR-a4_Rytv_-gvaA7O_bvu4';

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
