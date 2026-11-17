import { pool } from './db';

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_bn TEXT NOT NULL,
      short_name TEXT NOT NULL,
      short_name_bn TEXT NOT NULL,
      description TEXT NOT NULL,
      description_bn TEXT NOT NULL,
      image_url TEXT NOT NULL,
      accent_tint TEXT NOT NULL DEFAULT 'bg-emerald-50 text-emerald-900 border-emerald-200',
      item_count_label TEXT NOT NULL DEFAULT '',
      item_count_label_bn TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      name_bn TEXT NOT NULL,
      brand TEXT NOT NULL,
      brand_bn TEXT NOT NULL,
      category_slug TEXT NOT NULL REFERENCES categories(slug) ON UPDATE CASCADE,
      price INTEGER NOT NULL,
      original_price INTEGER,
      unit TEXT NOT NULL,
      unit_bn TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      rating NUMERIC(3, 1) NOT NULL DEFAULT 4.8,
      review_count INTEGER NOT NULL DEFAULT 0,
      in_stock BOOLEAN NOT NULL DEFAULT TRUE,
      stock_count INTEGER NOT NULL DEFAULT 25,
      description TEXT NOT NULL,
      description_bn TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'Bangladesh',
      origin_bn TEXT NOT NULL DEFAULT 'বাংলাদেশ',
      shelf_life TEXT NOT NULL DEFAULT 'Fresh daily stock',
      shelf_life_bn TEXT NOT NULL DEFAULT 'প্রতিদিনের টাটকা মজুদ',
      delivery_eta TEXT,
      delivery_eta_bn TEXT,
      image_url TEXT NOT NULL,
      image_focus TEXT,
      secondary_images TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      is_best_seller BOOLEAN NOT NULL DEFAULT FALSE,
      is_flash_deal BOOLEAN NOT NULL DEFAULT FALSE,
      is_new BOOLEAN NOT NULL DEFAULT FALSE,
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE products ADD COLUMN IF NOT EXISTS secondary_images TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

    CREATE TABLE IF NOT EXISTS product_variants (
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      label_bn TEXT,
      price INTEGER NOT NULL,
      original_price INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS delivery_areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_bn TEXT NOT NULL,
      fee INTEGER NOT NULL,
      free_threshold INTEGER NOT NULL,
      eta TEXT NOT NULL,
      eta_bn TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      description_bn TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('percent', 'flat', 'free-delivery')),
      value INTEGER NOT NULL,
      min_subtotal INTEGER NOT NULL DEFAULT 0,
      max_discount INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      show_in_banner BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE coupons ADD COLUMN IF NOT EXISTS show_in_banner BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE coupons ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id UUID PRIMARY KEY,
      email TEXT,
      full_name TEXT,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number TEXT UNIQUE NOT NULL,
      user_id UUID,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      area_id TEXT NOT NULL,
      area_name TEXT NOT NULL,
      area_name_bn TEXT,
      address TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Dhaka',
      delivery_slot TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      wallet_number TEXT,
      notes TEXT,
      coupon_code TEXT,
      subtotal INTEGER NOT NULL,
      item_savings INTEGER NOT NULL DEFAULT 0,
      coupon_discount INTEGER NOT NULL DEFAULT 0,
      delivery_fee INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id SERIAL PRIMARY KEY,
      coupon_code TEXT NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
      account_key TEXT NOT NULL,
      user_id UUID,
      customer_email TEXT,
      customer_phone TEXT,
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (coupon_code, account_key)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT,
      variant_label TEXT NOT NULL,
      variant_label_bn TEXT,
      name TEXT NOT NULL,
      name_bn TEXT NOT NULL,
      brand TEXT NOT NULL,
      image_url TEXT NOT NULL,
      unit_price INTEGER NOT NULL,
      original_unit_price INTEGER,
      quantity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_slug);
    CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(coupon_code);
  `);
}
