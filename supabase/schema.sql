-- Nandini Unique Boutique: database, security rules and photo storage.
-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; existing data is kept.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Owners. Only users listed here can change the catalog or see orders.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.admins enable row level security;
drop policy if exists "owners can see themselves" on public.admins;
create policy "owners can see themselves" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Products (sarees and dresses)
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id text primary key default gen_random_uuid()::text,
  name text not null check (char_length(name) between 1 and 90),
  detail text not null default '' check (char_length(detail) <= 100),
  description text not null default '' check (char_length(description) <= 1500),
  type text not null default 'Saree' check (type in ('Saree', 'Dress')),
  category text not null check (char_length(category) between 1 and 40),
  price integer not null check (price > 0),                       -- whole rupees
  original_price integer check (original_price is null or original_price > 0),
  tag text not null default 'New arrival' check (char_length(tag) <= 40),
  images text[] not null default '{}' check (cardinality(images) <= 6),
  alt text not null default '' check (char_length(alt) <= 160),
  stock integer check (stock is null or stock >= 0),              -- null = not tracked
  active boolean not null default true,                           -- false = hidden from the shop
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

alter table public.products enable row level security;

drop policy if exists "shop can read published products" on public.products;
create policy "shop can read published products" on public.products
  for select to anon, authenticated using (active or public.is_admin());

drop policy if exists "owners add products" on public.products;
create policy "owners add products" on public.products
  for insert to authenticated with check (public.is_admin());

drop policy if exists "owners edit products" on public.products;
create policy "owners edit products" on public.products
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "owners delete products" on public.products;
create policy "owners delete products" on public.products
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Orders. Customers never read or write these directly: the payment functions
-- (which use the service key) create and update them, and owners can read them.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,                                       -- e.g. NUB-20261015-4821
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'packed', 'shipped', 'delivered', 'cancelled')),
  customer_name text not null,
  phone text not null,
  address text not null,
  city_pin text not null,
  note text not null default '',
  subtotal integer not null check (subtotal > 0),                 -- whole rupees
  currency text not null default 'INR',
  razorpay_order_id text unique,
  razorpay_payment_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id text,
  name text not null,
  unit_price integer not null check (unit_price > 0),
  quantity integer not null check (quantity between 1 and 20)
);

create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists order_items_order_idx on public.order_items (order_id);

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "owners read orders" on public.orders;
create policy "owners read orders" on public.orders
  for select to authenticated using (public.is_admin());

drop policy if exists "owners update orders" on public.orders;
create policy "owners update orders" on public.orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "owners read order items" on public.order_items;
create policy "owners read order items" on public.order_items
  for select to authenticated using (public.is_admin());

-- Marks an order paid exactly once and reduces stock for tracked products.
-- Only the payment functions (service role) may call it.
create or replace function public.mark_order_paid(p_razorpay_order_id text, p_payment_id text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    raise exception 'Unknown order';
  end if;
  if o.status = 'pending' or o.status = 'failed' then
    update public.orders
       set status = 'paid', razorpay_payment_id = p_payment_id, paid_at = now()
     where id = o.id
     returning * into o;
    update public.products p
       set stock = greatest(p.stock - oi.quantity, 0)
      from public.order_items oi
     where oi.order_id = o.id and p.id = oi.product_id and p.stock is not null;
  end if;
  return o;
end;
$$;

revoke all on function public.mark_order_paid(text, text) from public, anon, authenticated;
grant execute on function public.mark_order_paid(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Photo storage: a public bucket (anyone can view photos); only owners upload.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "anyone can view product photos" on storage.objects;
create policy "anyone can view product photos" on storage.objects
  for select to anon, authenticated using (bucket_id = 'product-photos');

drop policy if exists "owners upload product photos" on storage.objects;
create policy "owners upload product photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-photos' and public.is_admin());

drop policy if exists "owners replace product photos" on storage.objects;
create policy "owners replace product photos" on storage.objects
  for update to authenticated using (bucket_id = 'product-photos' and public.is_admin());

drop policy if exists "owners delete product photos" on storage.objects;
create policy "owners delete product photos" on storage.objects
  for delete to authenticated using (bucket_id = 'product-photos' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Make yourself an owner (run AFTER creating your login in Authentication -> Users):
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'nandiniuniqueboutique@gmail.com'
--   on conflict do nothing;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Starter catalog (the products from the old products.json). Photos are the
-- representative placeholders; replace them from the admin page.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, detail, description, type, category, price, original_price, tag, images, alt, stock, active)
values
  ('trisha-inspired', 'Trisha Inspired Saree', 'Semi Kanjivaram', '', 'Saree', 'Silk', 1800, 2000, '10% OFF', array['https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=900&q=82'], 'Representative red and gold saree photo', null, true),
  ('mirror-work', 'Mirror Work Saree', 'Viscose', '', 'Saree', 'Festive', 1080, 1200, '10% OFF', array['https://images.pexels.com/photos/30004204/pexels-photo-30004204.jpeg?auto=compress&cs=tinysrgb&w=900'], 'Representative black and gold saree photo', null, true),
  ('tussar-georgette', 'Tussar Georgette', 'Kalamkari', '', 'Saree', 'Everyday', 990, 1100, '10% OFF', array['https://images.unsplash.com/photo-1617627143750-d86bc21e42bb?auto=format&fit=crop&w=900&q=82'], 'Representative blue saree photo', null, true),
  ('designer-kanjivaram', 'Designer Saree', 'Kanjivaram', '', 'Saree', 'Silk', 1500, null, 'Designer pick', array['https://images.pexels.com/photos/37054322/pexels-photo-37054322.jpeg?auto=compress&cs=tinysrgb&w=900'], 'Representative gold saree photo', null, true),
  ('vazhainar-pattu', 'Vazhainar pattu', 'Silk', '', 'Saree', 'Silk', 3780, 4200, '10% OFF', array['https://images.pexels.com/photos/28943474/pexels-photo-28943474.jpeg?auto=compress&cs=tinysrgb&w=900'], 'Representative orange saree photo', null, true)
on conflict (id) do nothing;
