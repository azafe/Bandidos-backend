import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "photos";

let client = null;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required for photo uploads");
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

export async function uploadPhoto(folder, entityId, buffer, contentType) {
  const path = `${folder}/${entityId}`;
  const { error } = await getClient()
    .storage.from(SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) throw error;

  const { data } = getClient().storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
