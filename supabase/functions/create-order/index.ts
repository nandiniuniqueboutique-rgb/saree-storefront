// Creates a pending order and a Razorpay order. Prices come from the database, not the browser.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOrderHandler } from "../_shared/handlers.js";
import { makeDb } from "../_shared/db.js";

const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(createOrderHandler({
  db: makeDb(client),
  fetch,
  keyId: Deno.env.get("RAZORPAY_KEY_ID"),
  keySecret: Deno.env.get("RAZORPAY_KEY_SECRET"),
  allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") || "https://store.nandhiniunique.com").split(",").map(s => s.trim())
}));
