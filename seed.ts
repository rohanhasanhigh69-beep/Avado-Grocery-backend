import 'dotenv/config';
import { pool } from './db';
import { ensureSchema } from './schema';
import { CATEGORIES } from './seedData/categories';
import { PRODUCTS } from './seedData/products';
import { GROCERY_IMAGES } from './seedData/images';
import { COUPONS, DELIVERY_AREAS } from '../frontend/src/utils/groceryLogic';

export async function seedCatalog(force = false): Promise<void> {
  await ensureSchema();

  if (!force) {
    const existing = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
    const settingsCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM site_settings'
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0 && Number(settingsCount.rows[0]?.count ?? 0) >= 2) {
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO site_settings (key, value) VALUES
        ('hero_banner_url', $1),
        ('promo_harvest_url', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [GROCERY_IMAGES.heroBanner, GROCERY_IMAGES.promoHarvest]
    );

    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      await client.query(
        `INSERT INTO categories (
          slug, name, name_bn, short_name, short_name_bn,
          description, description_bn, image_url, accent_tint,
          item_count_label, item_count_label_bn, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          name_bn = EXCLUDED.name_bn,
          short_name = EXCLUDED.short_name,
          short_name_bn = EXCLUDED.short_name_bn,
          description = EXCLUDED.description,
          description_bn = EXCLUDED.description_bn,
          image_url = EXCLUDED.image_url,
          accent_tint = EXCLUDED.accent_tint,
          item_count_label = EXCLUDED.item_count_label,
          item_count_label_bn = EXCLUDED.item_count_label_bn,
          sort_order = EXCLUDED.sort_order`,
        [
          cat.slug,
          cat.name,
          cat.nameBn,
          cat.shortName,
          cat.shortNameBn,
          cat.description,
          cat.descriptionBn,
          cat.image,
          cat.accentTint,
          cat.itemCountLabel,
          cat.itemCountLabelBn,
          i,
        ]
      );
    }

    for (const prod of PRODUCTS) {
      await client.query(
        `INSERT INTO products (
          id, slug, name, name_bn, brand, brand_bn, category_slug,
          price, original_price, unit, unit_bn, unit_type,
          rating, review_count, in_stock, stock_count,
          description, description_bn, origin, origin_bn,
          shelf_life, shelf_life_bn, delivery_eta, delivery_eta_bn,
          image_url, image_focus, is_best_seller, is_flash_deal, is_new, tags
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11,$12,
          $13,$14,$15,$16,
          $17,$18,$19,$20,
          $21,$22,$23,$24,
          $25,$26,$27,$28,$29,$30
        )
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug,
          name = EXCLUDED.name,
          name_bn = EXCLUDED.name_bn,
          brand = EXCLUDED.brand,
          brand_bn = EXCLUDED.brand_bn,
          category_slug = EXCLUDED.category_slug,
          price = EXCLUDED.price,
          original_price = EXCLUDED.original_price,
          unit = EXCLUDED.unit,
          unit_bn = EXCLUDED.unit_bn,
          unit_type = EXCLUDED.unit_type,
          rating = EXCLUDED.rating,
          review_count = EXCLUDED.review_count,
          in_stock = EXCLUDED.in_stock,
          stock_count = EXCLUDED.stock_count,
          description = EXCLUDED.description,
          description_bn = EXCLUDED.description_bn,
          origin = EXCLUDED.origin,
          origin_bn = EXCLUDED.origin_bn,
          shelf_life = EXCLUDED.shelf_life,
          shelf_life_bn = EXCLUDED.shelf_life_bn,
          delivery_eta = EXCLUDED.delivery_eta,
          delivery_eta_bn = EXCLUDED.delivery_eta_bn,
          image_url = EXCLUDED.image_url,
          image_focus = EXCLUDED.image_focus,
          is_best_seller = EXCLUDED.is_best_seller,
          is_flash_deal = EXCLUDED.is_flash_deal,
          is_new = EXCLUDED.is_new,
          tags = EXCLUDED.tags`,
        [
          prod.id,
          prod.slug,
          prod.name,
          prod.nameBn,
          prod.brand,
          prod.brandBn,
          prod.category,
          prod.price,
          prod.originalPrice ?? null,
          prod.unit,
          prod.unitBn,
          prod.unitType,
          prod.rating,
          prod.reviewCount,
          prod.inStock,
          prod.stockCount,
          prod.description,
          prod.descriptionBn,
          prod.origin,
          prod.originBn,
          prod.shelfLife,
          prod.shelfLifeBn,
          prod.deliveryEta ?? null,
          prod.deliveryEtaBn ?? null,
          prod.image,
          prod.imageFocus ?? null,
          Boolean(prod.isBestSeller),
          Boolean(prod.isFlashDeal),
          Boolean(prod.isNew),
          prod.tags ?? [],
        ]
      );

      await client.query('DELETE FROM product_variants WHERE product_id = $1', [prod.id]);
      if (prod.variants && prod.variants.length > 0) {
        for (let vIdx = 0; vIdx < prod.variants.length; vIdx++) {
          const variant = prod.variants[vIdx];
          await client.query(
            `INSERT INTO product_variants (product_id, label, label_bn, price, original_price, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              prod.id,
              variant.label,
              variant.labelBn ?? variant.label,
              variant.price,
              variant.originalPrice ?? null,
              vIdx,
            ]
          );
        }
      }
    }

    for (let i = 0; i < DELIVERY_AREAS.length; i++) {
      const area = DELIVERY_AREAS[i];
      await client.query(
        `INSERT INTO delivery_areas (id, name, name_bn, fee, free_threshold, eta, eta_bn, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           name_bn = EXCLUDED.name_bn,
           fee = EXCLUDED.fee,
           free_threshold = EXCLUDED.free_threshold,
           eta = EXCLUDED.eta,
           eta_bn = EXCLUDED.eta_bn,
           sort_order = EXCLUDED.sort_order`,
        [area.id, area.name, area.nameBn, area.fee, area.freeThreshold, area.eta, area.etaBn, i]
      );
    }

    for (const coupon of COUPONS) {
      await client.query(
        `INSERT INTO coupons (code, description, description_bn, type, value, min_subtotal, max_discount, active, show_in_banner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
         ON CONFLICT (code) DO UPDATE SET
           description = EXCLUDED.description,
           description_bn = EXCLUDED.description_bn,
           type = EXCLUDED.type,
           value = EXCLUDED.value,
           min_subtotal = EXCLUDED.min_subtotal,
           max_discount = EXCLUDED.max_discount,
           active = TRUE,
           show_in_banner = EXCLUDED.show_in_banner`,
        [
          coupon.code,
          coupon.description,
          coupon.descriptionBn,
          coupon.type,
          coupon.value,
          coupon.minSubtotal,
          coupon.maxDiscount ?? null,
          coupon.code === 'AVADO10',
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const isCli = process.argv[1]?.endsWith('seed.ts');
if (isCli) {
  seedCatalog(true)
    .then(async () => {
      const counts = await pool.query(
        `SELECT
          (SELECT COUNT(*) FROM categories)::int AS categories,
          (SELECT COUNT(*) FROM products)::int AS products,
          (SELECT COUNT(*) FROM product_variants)::int AS variants,
          (SELECT COUNT(*) FROM delivery_areas)::int AS delivery_areas,
          (SELECT COUNT(*) FROM coupons)::int AS coupons,
          (SELECT COUNT(*) FROM site_settings)::int AS site_settings`
      );
      console.log('✓ Seeded Supabase PostgreSQL:', counts.rows[0]);
      await pool.end();
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await pool.end();
      process.exit(1);
    });
}
