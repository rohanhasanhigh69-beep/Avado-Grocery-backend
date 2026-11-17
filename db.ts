import 'dotenv/config';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const MEDIA_BUCKET = 'avado-media';

export const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? 'avadotech69@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

if (!DATABASE_URL) {
  console.warn('[Avado Backend] Warning: DATABASE_URL is not set.');
}

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const supabaseAdmin: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

export async function ensureMediaBucket(): Promise<void> {
  if (!supabaseAdmin) return;
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) {
    throw new Error(`Failed to list Supabase buckets: ${error.message}`);
  }
  const exists = buckets?.some((b) => b.name === MEDIA_BUCKET);
  if (!exists) {
    const { error: createErr } = await supabaseAdmin.storage.createBucket(MEDIA_BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024,
      allowedMimeTypes: ['image/webp', 'image/jpeg', 'image/png'],
    });
    if (createErr) {
      throw new Error(`Failed to create bucket ${MEDIA_BUCKET}: ${createErr.message}`);
    }
  }
}

export function getPublicMediaUrl(storagePath: string): string {
  const cleanBase = SUPABASE_URL.replace(/\/+$/, '');
  const cleanPath = storagePath.replace(/^\/+/, '');
  return `${cleanBase}/storage/v1/object/public/${MEDIA_BUCKET}/${cleanPath}`;
}
