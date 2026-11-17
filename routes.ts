import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {
  ADMIN_EMAILS,
  MEDIA_BUCKET,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  ensureMediaBucket,
  getPublicMediaUrl,
  pool,
  supabaseAdmin,
} from './db';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

interface AuthenticatedRequest extends Request {
  authUser?: {
    id: string;
    email: string;
    role: 'customer' | 'admin';
    fullName?: string;
  };
}

function mapCategoryRow(row: Record<string, unknown>) {
  return {
    slug: String(row.slug),
    name: String(row.name),
    nameBn: String(row.name_bn),
    shortName: String(row.short_name),
    shortNameBn: String(row.short_name_bn),
    description: String(row.description),
    descriptionBn: String(row.description_bn),
    image: String(row.image_url),
    accentTint: String(row.accent_tint),
    itemCountLabel: String(row.item_count_label ?? ''),
    itemCountLabelBn: String(row.item_count_label_bn ?? ''),
  };
}

function mapProductRow(
  row: Record<string, unknown>,
  variantsByProduct: Map<string, Array<{ label: string; labelBn?: string; price: number; originalPrice?: number }>>
) {
  const id = String(row.id);
  const variants = variantsByProduct.get(id);
  return {
    id,
    slug: String(row.slug),
    name: String(row.name),
    nameBn: String(row.name_bn),
    brand: String(row.brand),
    brandBn: String(row.brand_bn),
    category: String(row.category_slug),
    price: Number(row.price),
    originalPrice: row.original_price != null ? Number(row.original_price) : undefined,
    unit: String(row.unit),
    unitBn: String(row.unit_bn),
    unitType: String(row.unit_type),
    variants: variants && variants.length > 0 ? variants : undefined,
    rating: Number(row.rating),
    reviewCount: Number(row.review_count),
    inStock: Boolean(row.in_stock),
    stockCount: Number(row.stock_count),
    description: String(row.description),
    descriptionBn: String(row.description_bn),
    origin: String(row.origin),
    originBn: String(row.origin_bn),
    shelfLife: String(row.shelf_life),
    shelfLifeBn: String(row.shelf_life_bn),
    deliveryEta: row.delivery_eta ? String(row.delivery_eta) : undefined,
    deliveryEtaBn: row.delivery_eta_bn ? String(row.delivery_eta_bn) : undefined,
    image: String(row.image_url),
    imageFocus: row.image_focus ? String(row.image_focus) : undefined,
    secondaryImages: Array.isArray(row.secondary_images) ? (row.secondary_images as string[]) : [],
    isBestSeller: Boolean(row.is_best_seller),
    isFlashDeal: Boolean(row.is_flash_deal),
    isNew: Boolean(row.is_new),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
  };
}

async function fetchAllProducts(filters?: { category?: string; q?: string; dealsOnly?: boolean }) {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters?.category && filters.category !== 'all') {
    params.push(filters.category);
    where.push(`category_slug = $${params.length}`);
  }
  if (filters?.dealsOnly) {
    where.push(`(is_flash_deal = TRUE OR (original_price IS NOT NULL AND original_price > price))`);
  }
  if (filters?.q && filters.q.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(
      `(name ILIKE $${params.length} OR name_bn ILIKE $${params.length} OR brand ILIKE $${params.length} OR brand_bn ILIKE $${params.length})`
    );
  }

  const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id ASC`;
  const [prodRes, varRes] = await Promise.all([
    pool.query(sql, params),
    pool.query('SELECT * FROM product_variants ORDER BY sort_order ASC, id ASC'),
  ]);

  const variantsByProduct = new Map<
    string,
    Array<{ label: string; labelBn?: string; price: number; originalPrice?: number }>
  >();

  for (const v of varRes.rows) {
    const pid = String(v.product_id);
    if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
    variantsByProduct.get(pid)!.push({
      label: String(v.label),
      labelBn: v.label_bn ? String(v.label_bn) : undefined,
      price: Number(v.price),
      originalPrice: v.original_price != null ? Number(v.original_price) : undefined,
    });
  }

  return prodRes.rows.map((row) => mapProductRow(row, variantsByProduct));
}

async function resolveAuthUser(req: AuthenticatedRequest) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || !supabaseAdmin) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;

  const user = data.user;
  const email = (user.email ?? '').toLowerCase();
  const isDefaultAdmin = email ? ADMIN_EMAILS.has(email) : false;
  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : '';

  const profileRes = await pool.query(
    `INSERT INTO profiles (id, email, full_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, profiles.email),
       full_name = CASE WHEN profiles.full_name IS NULL OR profiles.full_name = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
       role = CASE WHEN $4 = 'admin' THEN 'admin' ELSE profiles.role END
     RETURNING role, full_name`,
    [user.id, email || null, fullName || null, isDefaultAdmin ? 'admin' : 'customer']
  );

  const role = profileRes.rows[0]?.role === 'admin' ? 'admin' : 'customer';
  return {
    id: user.id,
    email,
    role: role as 'customer' | 'admin',
    fullName: (profileRes.rows[0]?.full_name as string) || fullName || undefined,
  };
}

async function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  try {
    const resolved = await resolveAuthUser(req);
    if (resolved) req.authUser = resolved;
  } catch {
    // ignore invalid optional tokens
  }
  next();
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveAuthUser(req);
    if (!resolved) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.authUser = resolved;
    next();
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
}

async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveAuthUser(req);
    if (!resolved) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (resolved.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    req.authUser = resolved;
    next();
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
}

// Health & Public Config
router.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'postgresql', provider: 'supabase' });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get('/config', (_req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
  });
});

// Public Storefront Bootstrap
router.get('/bootstrap', async (_req, res) => {
  try {
    const [catRes, products, areaRes, couponRes, settingsRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order ASC'),
      fetchAllProducts(),
      pool.query('SELECT * FROM delivery_areas ORDER BY sort_order ASC'),
      pool.query(
        'SELECT * FROM coupons WHERE active = TRUE ORDER BY show_in_banner DESC, created_at DESC, code ASC'
      ),
      pool.query('SELECT key, value FROM site_settings'),
    ]);

    const settingsMap = new Map<string, string>();
    for (const row of settingsRes.rows) {
      settingsMap.set(String(row.key), String(row.value));
    }

    res.json({
      categories: catRes.rows.map(mapCategoryRow),
      products,
      deliveryAreas: areaRes.rows.map((a) => ({
        id: String(a.id),
        name: String(a.name),
        nameBn: String(a.name_bn),
        fee: Number(a.fee),
        freeThreshold: Number(a.free_threshold),
        eta: String(a.eta),
        etaBn: String(a.eta_bn),
      })),
      coupons: couponRes.rows.map((c) => ({
        code: String(c.code),
        description: String(c.description),
        descriptionBn: String(c.description_bn),
        type: String(c.type),
        value: Number(c.value),
        minSubtotal: Number(c.min_subtotal),
        maxDiscount: c.max_discount != null ? Number(c.max_discount) : undefined,
        active: Boolean(c.active),
        showInBanner: Boolean(c.show_in_banner),
      })),
      siteMedia: {
        heroBannerUrl:
          settingsMap.get('hero_banner_url') ?? getPublicMediaUrl('catalog/heroBanner.webp'),
        promoHarvestUrl:
          settingsMap.get('promo_harvest_url') ?? getPublicMediaUrl('catalog/promoHarvest.webp'),
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/categories', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC');
    res.json({ categories: result.rows.map(mapCategoryRow) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const products = await fetchAllProducts({
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      dealsOnly: req.query.deals === 'true',
    });
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const prodRes = await pool.query('SELECT * FROM products WHERE id = $1 OR slug = $1 LIMIT 1', [
      req.params.id,
    ]);
    if (prodRes.rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    const row = prodRes.rows[0];
    const varRes = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
      [row.id]
    );
    const map = new Map();
    map.set(
      String(row.id),
      varRes.rows.map((v) => ({
        label: String(v.label),
        labelBn: v.label_bn ? String(v.label_bn) : undefined,
        price: Number(v.price),
        originalPrice: v.original_price != null ? Number(v.original_price) : undefined,
      }))
    );
    res.json({ product: mapProductRow(row, map) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Server-side Coupon Validation (enforces active state + 1 use per account)
router.post('/coupons/validate', optionalAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const code = String(req.body?.code ?? '')
      .trim()
      .toUpperCase();
    const subtotal = Number(req.body?.subtotal ?? 0);
    const emailInput = String(req.body?.email ?? req.authUser?.email ?? '').trim().toLowerCase();
    const phoneInput = String(req.body?.phone ?? '').replace(/[\s-]/g, '');

    if (!code) {
      res.json({ valid: false, error: 'Please enter a promo code.' });
      return;
    }

    const result = await pool.query('SELECT * FROM coupons WHERE code = $1 AND active = TRUE', [
      code,
    ]);
    if (result.rows.length === 0) {
      res.json({
        valid: false,
        error: `Promo code "${code}" is invalid or has been removed.`,
      });
      return;
    }

    if (req.authUser?.id || emailInput || phoneInput) {
      const usedRes = await pool.query(
        `SELECT cr.id FROM coupon_redemptions cr
         LEFT JOIN orders o ON o.id = cr.order_id
         WHERE cr.coupon_code = $1
           AND (o.status IS NULL OR o.status != 'cancelled')
           AND (
             ($2::uuid IS NOT NULL AND cr.user_id = $2::uuid)
             OR ($3::text != '' AND LOWER(cr.customer_email) = LOWER($3::text))
             OR ($4::text != '' AND cr.customer_phone = $4::text)
           )
         LIMIT 1`,
        [code, req.authUser?.id ?? null, emailInput, phoneInput]
      );
      if (usedRes.rows.length > 0) {
        res.json({
          valid: false,
          error: `Promo code ${code} can only be used once per account.`,
        });
        return;
      }
    }

    const coupon = result.rows[0];
    if (subtotal > 0 && subtotal < Number(coupon.min_subtotal)) {
      res.json({
        valid: false,
        error: `Code ${coupon.code} requires at least ৳${Number(coupon.min_subtotal)} subtotal.`,
      });
      return;
    }

    res.json({
      valid: true,
      coupon: {
        code: String(coupon.code),
        description: String(coupon.description),
        descriptionBn: String(coupon.description_bn),
        type: String(coupon.type),
        value: Number(coupon.value),
        minSubtotal: Number(coupon.min_subtotal),
        maxDiscount: coupon.max_discount != null ? Number(coupon.max_discount) : undefined,
        showInBanner: Boolean(coupon.show_in_banner),
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Transactional Checkout & Order Placement
router.post('/orders', optionalAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body ?? {};
  const customer = body.customer ?? {};
  const itemsInput = Array.isArray(body.items) ? body.items : [];
  const couponCodeInput = String(body.couponCode ?? '')
    .trim()
    .toUpperCase();

  const fullName = String(customer.fullName ?? '').trim();
  const phoneDigits = String(customer.phone ?? '').replace(/[\s-]/g, '');
  const email = String(customer.email ?? '').trim();
  const areaId = String(customer.areaId ?? '').trim();
  const address = String(customer.address ?? '').trim();
  const city = String(customer.city ?? 'Dhaka').trim() || 'Dhaka';
  const deliverySlot = String(customer.deliverySlot ?? 'Express (45–60 mins)').trim();
  const paymentMethod = String(customer.paymentMethod ?? 'cod').trim();
  const walletNumber = String(customer.walletNumber ?? '').trim();
  const notes = String(customer.notes ?? '').trim();

  if (!fullName || fullName.length < 2) {
    res.status(400).json({ error: 'Please enter your full name.' });
    return;
  }
  if (!/^(\+?88)?01[3-9]\d{8}$/.test(phoneDigits)) {
    res.status(400).json({ error: 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).' });
    return;
  }
  if (!address || address.length < 6) {
    res.status(400).json({ error: 'Enter your complete house, road & sector address.' });
    return;
  }
  if (itemsInput.length === 0) {
    res.status(400).json({ error: 'Your shopping bag is empty.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const areaRes = await client.query('SELECT * FROM delivery_areas WHERE id = $1', [areaId]);
    const fallbackAreaRes =
      areaRes.rows.length > 0
        ? areaRes
        : await client.query('SELECT * FROM delivery_areas ORDER BY sort_order ASC LIMIT 1');
    const area = fallbackAreaRes.rows[0];

    let subtotal = 0;
    let itemSavings = 0;
    let totalQuantity = 0;

    const resolvedItems: Array<{
      productId: string;
      variantLabel: string;
      variantLabelBn: string;
      name: string;
      nameBn: string;
      brand: string;
      brandBn: string;
      image: string;
      unitPrice: number;
      originalUnitPrice?: number;
      quantity: number;
      category: string;
    }> = [];

    for (const rawItem of itemsInput) {
      const productId = String(rawItem.productId ?? '');
      const requestedVariant = String(rawItem.variantLabel ?? '');
      const quantity = Math.max(1, Math.min(99, Math.floor(Number(rawItem.quantity ?? 1))));

      const prodRes = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [
        productId,
      ]);
      if (prodRes.rows.length === 0) {
        throw new Error(`Product ${productId} not found`);
      }
      const prod = prodRes.rows[0];
      if (!prod.in_stock || Number(prod.stock_count) <= 0) {
        throw new Error(`${prod.name} is currently out of stock`);
      }

      const varRes = await client.query(
        'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC',
        [productId]
      );
      const matchedVariant =
        varRes.rows.find((v) => String(v.label) === requestedVariant) ?? varRes.rows[0] ?? null;

      const unitPrice = matchedVariant ? Number(matchedVariant.price) : Number(prod.price);
      const originalUnitPrice = matchedVariant
        ? matchedVariant.original_price != null
          ? Number(matchedVariant.original_price)
          : undefined
        : prod.original_price != null
        ? Number(prod.original_price)
        : undefined;

      const variantLabel = matchedVariant ? String(matchedVariant.label) : String(prod.unit);
      const variantLabelBn = matchedVariant
        ? String(matchedVariant.label_bn ?? matchedVariant.label)
        : String(prod.unit_bn);

      subtotal += unitPrice * quantity;
      totalQuantity += quantity;
      if (originalUnitPrice && originalUnitPrice > unitPrice) {
        itemSavings += (originalUnitPrice - unitPrice) * quantity;
      }

      const nextStock = Math.max(0, Number(prod.stock_count) - quantity);
      await client.query('UPDATE products SET stock_count = $1, in_stock = $2 WHERE id = $3', [
        nextStock,
        nextStock > 0,
        productId,
      ]);

      resolvedItems.push({
        productId,
        variantLabel,
        variantLabelBn,
        name: String(prod.name),
        nameBn: String(prod.name_bn),
        brand: String(prod.brand),
        brandBn: String(prod.brand_bn),
        image: String(prod.image_url),
        unitPrice,
        originalUnitPrice,
        quantity,
        category: String(prod.category_slug),
      });
    }

    let appliedCoupon: Record<string, unknown> | null = null;
    let couponDiscount = 0;
    let freeDeliveryByCoupon = false;

    const normalizedEmail = (email || req.authUser?.email || '').trim().toLowerCase();

    if (couponCodeInput) {
      const cRes = await client.query('SELECT * FROM coupons WHERE code = $1 AND active = TRUE', [
        couponCodeInput,
      ]);
      if (cRes.rows.length === 0) {
        throw new Error(`Promo code "${couponCodeInput}" is invalid or has been deleted.`);
      }
      const couponRow = cRes.rows[0];
      if (subtotal < Number(couponRow.min_subtotal)) {
        throw new Error(
          `Promo code ${couponRow.code} requires at least ৳${Number(couponRow.min_subtotal)} subtotal.`
        );
      }

      // Enforce strictly 1 redemption per account (by user_id, email, or phone)
      const usedRes = await client.query(
        `SELECT cr.id FROM coupon_redemptions cr
         LEFT JOIN orders o ON o.id = cr.order_id
         WHERE cr.coupon_code = $1
           AND (o.status IS NULL OR o.status != 'cancelled')
           AND (
             ($2::uuid IS NOT NULL AND cr.user_id = $2::uuid)
             OR ($3::text != '' AND LOWER(cr.customer_email) = LOWER($3::text))
             OR ($4::text != '' AND cr.customer_phone = $4::text)
           )
         LIMIT 1`,
        [couponCodeInput, req.authUser?.id ?? null, normalizedEmail, phoneDigits]
      );
      if (usedRes.rows.length > 0) {
        throw new Error(`Promo code ${couponCodeInput} can only be used once per account.`);
      }

      appliedCoupon = couponRow;
      if (couponRow.type === 'percent') {
        const raw = Math.round((subtotal * Number(couponRow.value)) / 100);
        couponDiscount =
          couponRow.max_discount != null
            ? Math.min(raw, Number(couponRow.max_discount))
            : raw;
      } else if (couponRow.type === 'flat') {
        couponDiscount = Math.min(Number(couponRow.value), subtotal);
      } else if (couponRow.type === 'free-delivery') {
        freeDeliveryByCoupon = true;
      }
    }

    const deliveryFee =
      subtotal >= Number(area.free_threshold) || freeDeliveryByCoupon ? 0 : Number(area.fee);
    const total = Math.max(0, subtotal - couponDiscount + deliveryFee);
    const orderNumber = `AVD-${Math.floor(10000 + Math.random() * 90000)}`;

    const orderInsert = await client.query(
      `INSERT INTO orders (
        order_number, user_id, customer_name, customer_phone, customer_email,
        area_id, area_name, area_name_bn, address, city, delivery_slot,
        payment_method, wallet_number, notes, coupon_code,
        subtotal, item_savings, coupon_discount, delivery_fee, total, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending'
      ) RETURNING *`,
      [
        orderNumber,
        req.authUser?.id ?? null,
        fullName,
        phoneDigits,
        normalizedEmail || null,
        String(area.id),
        String(area.name),
        String(area.name_bn),
        address,
        city,
        deliverySlot,
        paymentMethod,
        walletNumber || null,
        notes || null,
        appliedCoupon ? String(appliedCoupon.code) : null,
        subtotal,
        itemSavings,
        couponDiscount,
        deliveryFee,
        total,
      ]
    );

    const insertedOrder = orderInsert.rows[0];

    if (appliedCoupon) {
      const accountKey = req.authUser?.id
        ? `user:${req.authUser.id}`
        : normalizedEmail
        ? `email:${normalizedEmail}`
        : `phone:${phoneDigits}`;
      await client.query(
        `INSERT INTO coupon_redemptions (
          coupon_code, account_key, user_id, customer_email, customer_phone, order_id
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          String(appliedCoupon.code),
          accountKey,
          req.authUser?.id ?? null,
          normalizedEmail || null,
          phoneDigits,
          insertedOrder.id,
        ]
      );
    }

    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO order_items (
          order_id, product_id, variant_label, variant_label_bn,
          name, name_bn, brand, image_url, unit_price, original_unit_price, quantity
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          insertedOrder.id,
          item.productId,
          item.variantLabel,
          item.variantLabelBn,
          item.name,
          item.nameBn,
          item.brand,
          item.image,
          item.unitPrice,
          item.originalUnitPrice ?? null,
          item.quantity,
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      order: {
        id: String(insertedOrder.id),
        orderId: String(insertedOrder.order_number),
        createdAt: new Date(insertedOrder.created_at).toISOString(),
        status: String(insertedOrder.status),
        customer: {
          fullName,
          phone: phoneDigits,
          email,
          areaId: String(area.id),
          address,
          city,
          deliverySlot,
          paymentMethod,
          walletNumber,
          notes,
        },
        areaName: String(area.name),
        areaNameBn: String(area.name_bn),
        items: resolvedItems,
        summary: {
          subtotal,
          itemSavings,
          couponDiscount,
          deliveryFee,
          freeDeliveryThreshold: Number(area.free_threshold),
          remainingForFreeDelivery: Math.max(0, Number(area.free_threshold) - subtotal),
          total,
          totalQuantity,
          appliedCoupon: appliedCoupon
            ? {
                code: String(appliedCoupon.code),
                description: String(appliedCoupon.description),
                descriptionBn: String(appliedCoupon.description_bn),
                type: String(appliedCoupon.type),
                value: Number(appliedCoupon.value),
                minSubtotal: Number(appliedCoupon.min_subtotal),
              }
            : null,
          couponError: null,
        },
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

// Auth & Customer Orders
router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.authUser });
});

router.get('/orders/mine', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT * FROM orders
       WHERE user_id = $1 OR (customer_email IS NOT NULL AND LOWER(customer_email) = LOWER($2))
       ORDER BY created_at DESC LIMIT 25`,
      [req.authUser!.id, req.authUser!.email]
    );
    const orderIds = ordersRes.rows.map((o) => o.id);
    const itemsRes =
      orderIds.length > 0
        ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds])
        : { rows: [] };

    const itemsByOrder = new Map<string, unknown[]>();
    for (const item of itemsRes.rows) {
      const oid = String(item.order_id);
      if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
      itemsByOrder.get(oid)!.push({
        productId: String(item.product_id),
        variantLabel: String(item.variant_label),
        variantLabelBn: item.variant_label_bn ? String(item.variant_label_bn) : undefined,
        name: String(item.name),
        nameBn: String(item.name_bn),
        brand: String(item.brand),
        image: String(item.image_url),
        unitPrice: Number(item.unit_price),
        originalUnitPrice:
          item.original_unit_price != null ? Number(item.original_unit_price) : undefined,
        quantity: Number(item.quantity),
      });
    }

    const orders = ordersRes.rows.map((o) => ({
      id: String(o.id),
      orderId: String(o.order_number),
      createdAt: new Date(o.created_at).toISOString(),
      status: String(o.status),
      areaName: String(o.area_name),
      areaNameBn: o.area_name_bn ? String(o.area_name_bn) : undefined,
      customer: {
        fullName: String(o.customer_name),
        phone: String(o.customer_phone),
        email: String(o.customer_email ?? ''),
        areaId: String(o.area_id),
        address: String(o.address),
        city: String(o.city),
        deliverySlot: String(o.delivery_slot),
        paymentMethod: String(o.payment_method),
      },
      items: itemsByOrder.get(String(o.id)) ?? [],
      summary: {
        subtotal: Number(o.subtotal),
        itemSavings: Number(o.item_savings),
        couponDiscount: Number(o.coupon_discount),
        deliveryFee: Number(o.delivery_fee),
        total: Number(o.total),
        totalQuantity: (itemsByOrder.get(String(o.id)) ?? []).reduce(
          (acc: number, it: unknown) => acc + Number((it as { quantity: number }).quantity),
          0
        ),
      },
    }));

    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Contact & Newsletter
router.post('/contact', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const message = String(req.body?.message ?? '').trim();

    if (!name || !phone || !message) {
      res.status(400).json({ error: 'Name, phone, and message are required.' });
      return;
    }

    await pool.query(
      'INSERT INTO contact_messages (name, phone, email, message) VALUES ($1,$2,$3,$4)',
      [name, phone, email || null, message]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/newsletter', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Valid email required.' });
      return;
    }

    await pool.query(
      'INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ================= ADMIN ROUTES =================
router.get('/admin/overview', requireAdmin, async (_req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM products)::int AS total_products,
        (SELECT COUNT(*) FROM products WHERE in_stock = FALSE OR stock_count <= 0)::int AS out_of_stock,
        (SELECT COUNT(*) FROM orders)::int AS total_orders,
        (SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'confirmed'))::int AS open_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'cancelled')::int AS total_revenue,
        (SELECT COUNT(*) FROM contact_messages)::int AS contact_messages
    `);
    res.json({ stats: stats.rows[0] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post(
  '/admin/upload',
  requireAdmin,
  upload.single('image'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.file || !supabaseAdmin) {
        res.status(400).json({ error: 'Image file is required.' });
        return;
      }

      await ensureMediaBucket();

      const target =
        req.query.target === 'banner'
          ? 'banner'
          : req.query.target === 'category'
          ? 'category'
          : 'product';
      const maxDim =
        target === 'banner' ? { width: 1400, height: 900 } : { width: 520, height: 520 };

      const webpBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ ...maxDim, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 5 })
        .toBuffer();

      const baseSlug = req.file.originalname
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 32);
      const folder = target === 'category' ? 'categories' : target === 'banner' ? 'banners' : 'products';
      const storagePath = `${folder}/${baseSlug || 'item'}-${Date.now()}.webp`;

      const { error } = await supabaseAdmin.storage
        .from(MEDIA_BUCKET)
        .upload(storagePath, webpBuffer, {
          contentType: 'image/webp',
          cacheControl: '31536000',
          upsert: false,
        });

      if (error) {
        throw new Error(error.message);
      }

      const originalSizeKB = Math.max(1, Math.round(req.file.buffer.byteLength / 1024));
      const sizeKB = Math.max(1, Math.round(webpBuffer.byteLength / 1024));
      const savedPercent = Math.max(
        0,
        Math.round(((req.file.buffer.byteLength - webpBuffer.byteLength) / req.file.buffer.byteLength) * 100)
      );

      res.json({
        url: getPublicMediaUrl(storagePath),
        sizeKB,
        originalSizeKB,
        savedPercent,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

router.post('/admin/products', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const id = String(b.id ?? `prd-${Date.now().toString(36)}`).trim();
  const name = String(b.name ?? '').trim();
  const nameBn = String(b.nameBn ?? name).trim();
  const categorySlug = String(b.category ?? 'fruits').trim();
  const price = Math.max(1, Math.round(Number(b.price ?? 0)));
  const originalPrice =
    b.originalPrice && Number(b.originalPrice) > price ? Math.round(Number(b.originalPrice)) : null;

  if (!name || !price) {
    res.status(400).json({ error: 'Product name and valid price are required.' });
    return;
  }

  const slug =
    String(b.slug ?? '')
      .trim()
      .toLowerCase() ||
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;

  const secondaryImages = Array.isArray(b.secondaryImages)
    ? b.secondaryImages.map((u: unknown) => String(u).trim()).filter(Boolean)
    : [];

  try {
    await pool.query(
      `INSERT INTO products (
        id, slug, name, name_bn, brand, brand_bn, category_slug,
        price, original_price, unit, unit_bn, unit_type,
        rating, review_count, in_stock, stock_count,
        description, description_bn, origin, origin_bn,
        shelf_life, shelf_life_bn, image_url, secondary_images, is_best_seller, is_flash_deal, is_new
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,4.8,12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,TRUE
      )`,
      [
        id,
        slug,
        name,
        nameBn,
        String(b.brand ?? 'Avado Fresh').trim(),
        String(b.brandBn ?? b.brand ?? 'অ্যাভাডো ফ্রেশ').trim(),
        categorySlug,
        price,
        originalPrice,
        String(b.unit ?? '1 kg').trim(),
        String(b.unitBn ?? b.unit ?? '১ কেজি').trim(),
        String(b.unitType ?? 'kg').trim(),
        b.inStock !== false && Number(b.stockCount ?? 25) > 0,
        Math.max(0, Math.round(Number(b.stockCount ?? 25))),
        String(b.description ?? `${name} fresh quality pack from Avado Grocery.`).trim(),
        String(b.descriptionBn ?? `${nameBn} — অ্যাভাডো গ্রোসারির টাটকা ও বাছাইকৃত পণ্য।`).trim(),
        String(b.origin ?? 'Bangladesh').trim(),
        String(b.originBn ?? 'বাংলাদেশ').trim(),
        String(b.shelfLife ?? 'Fresh daily stock').trim(),
        String(b.shelfLifeBn ?? 'প্রতিদিনের টাটকা মজুদ').trim(),
        String(b.image ?? getPublicMediaUrl('catalog/prodMango.webp')).trim(),
        secondaryImages,
        Boolean(b.isBestSeller),
        Boolean(b.isFlashDeal),
      ]
    );

    const created = await fetchAllProducts();
    const product = created.find((p) => p.id === id);
    res.status(201).json({ product });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.put('/admin/products/:id', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const id = req.params.id;
  try {
    const existingRes = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existingRes.rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    const existing = existingRes.rows[0];
    const nextStock =
      b.stockCount != null ? Math.max(0, Math.round(Number(b.stockCount))) : Number(existing.stock_count);
    const nextInStock = b.inStock != null ? Boolean(b.inStock) && nextStock > 0 : nextStock > 0;
    const nextPrice = b.price != null ? Math.max(1, Math.round(Number(b.price))) : Number(existing.price);
    const nextOriginal =
      b.originalPrice !== undefined
        ? b.originalPrice && Number(b.originalPrice) > nextPrice
          ? Math.round(Number(b.originalPrice))
          : null
        : existing.original_price;
    const nextSecondary = Array.isArray(b.secondaryImages)
      ? b.secondaryImages.map((u: unknown) => String(u).trim()).filter(Boolean)
      : existing.secondary_images ?? [];

    await pool.query(
      `UPDATE products SET
        name = $1,
        name_bn = $2,
        brand = $3,
        brand_bn = $4,
        category_slug = $5,
        price = $6,
        original_price = $7,
        unit = $8,
        unit_bn = $9,
        unit_type = $10,
        stock_count = $11,
        in_stock = $12,
        description = $13,
        description_bn = $14,
        is_flash_deal = $15,
        is_best_seller = $16,
        image_url = $17,
        secondary_images = $18
       WHERE id = $19`,
      [
        b.name != null ? String(b.name).trim() : existing.name,
        b.nameBn != null ? String(b.nameBn).trim() : existing.name_bn,
        b.brand != null ? String(b.brand).trim() : existing.brand,
        b.brandBn != null ? String(b.brandBn).trim() : existing.brand_bn,
        b.category != null ? String(b.category).trim() : existing.category_slug,
        nextPrice,
        nextOriginal,
        b.unit != null ? String(b.unit).trim() : existing.unit,
        b.unitBn != null ? String(b.unitBn).trim() : existing.unit_bn,
        b.unitType != null ? String(b.unitType).trim() : existing.unit_type,
        nextStock,
        nextInStock,
        b.description != null ? String(b.description).trim() : existing.description,
        b.descriptionBn != null ? String(b.descriptionBn).trim() : existing.description_bn,
        b.isFlashDeal != null ? Boolean(b.isFlashDeal) : existing.is_flash_deal,
        b.isBestSeller != null ? Boolean(b.isBestSeller) : existing.is_best_seller,
        b.image != null ? String(b.image).trim() : existing.image_url,
        nextSecondary,
        id,
      ]
    );

    const all = await fetchAllProducts();
    res.json({ product: all.find((p) => p.id === id) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Admin Category CRUD
router.post('/admin/categories', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  const nameBn = String(b.nameBn ?? name).trim();
  const shortName = String(b.shortName ?? name).trim();
  const shortNameBn = String(b.shortNameBn ?? nameBn).trim();
  const rawSlug = String(b.slug ?? name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!name || !rawSlug) {
    res.status(400).json({ error: 'Category name and slug are required.' });
    return;
  }

  try {
    const sortRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0)::int + 1 AS next_order FROM categories');
    const nextOrder = Number(sortRes.rows[0]?.next_order ?? 99);
    const result = await pool.query(
      `INSERT INTO categories (
        slug, name, name_bn, short_name, short_name_bn,
        description, description_bn, image_url, accent_tint,
        item_count_label, item_count_label_bn, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        rawSlug,
        name,
        nameBn,
        shortName,
        shortNameBn,
        String(b.description ?? `${name} — fresh curated grocery aisle.`).trim(),
        String(b.descriptionBn ?? `${nameBn} — অ্যাভাডো গ্রোসারির বাছাইকৃত পণ্যসমূহ।`).trim(),
        String(b.image ?? getPublicMediaUrl('catalog/catFruits.webp')).trim(),
        String(b.accentTint ?? 'bg-emerald-50 text-emerald-900 border-emerald-200').trim(),
        String(b.itemCountLabel ?? 'New Arrivals').trim(),
        String(b.itemCountLabelBn ?? 'নতুন কালেকশন').trim(),
        nextOrder,
      ]
    );
    res.status(201).json({ category: mapCategoryRow(result.rows[0]) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.put('/admin/categories/:slug', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const targetSlug = String(req.params.slug ?? '').trim();
  try {
    const existingRes = await pool.query('SELECT * FROM categories WHERE slug = $1', [targetSlug]);
    if (existingRes.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const existing = existingRes.rows[0];
    const nextSlug =
      b.slug != null && String(b.slug).trim()
        ? String(b.slug)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : existing.slug;

    const result = await pool.query(
      `UPDATE categories SET
        slug = $1,
        name = $2,
        name_bn = $3,
        short_name = $4,
        short_name_bn = $5,
        description = $6,
        description_bn = $7,
        image_url = $8,
        accent_tint = $9
       WHERE slug = $10
       RETURNING *`,
      [
        nextSlug,
        b.name != null ? String(b.name).trim() : existing.name,
        b.nameBn != null ? String(b.nameBn).trim() : existing.name_bn,
        b.shortName != null ? String(b.shortName).trim() : existing.short_name,
        b.shortNameBn != null ? String(b.shortNameBn).trim() : existing.short_name_bn,
        b.description != null ? String(b.description).trim() : existing.description,
        b.descriptionBn != null ? String(b.descriptionBn).trim() : existing.description_bn,
        b.image != null ? String(b.image).trim() : existing.image_url,
        b.accentTint != null ? String(b.accentTint).trim() : existing.accent_tint,
        targetSlug,
      ]
    );
    res.json({ category: mapCategoryRow(result.rows[0]) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/admin/categories/:slug', requireAdmin, async (req, res) => {
  const slug = String(req.params.slug ?? '').trim();
  try {
    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM products WHERE category_slug = $1',
      [slug]
    );
    const cnt = Number(countRes.rows[0]?.cnt ?? 0);
    if (cnt > 0) {
      res.status(400).json({
        error: `Cannot delete "${slug}" while ${cnt} product(s) are assigned to it. Move or delete those products first.`,
      });
      return;
    }
    await pool.query('DELETE FROM categories WHERE slug = $1', [slug]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Admin Promo Code CRUD
router.get('/admin/coupons', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
        COALESCE((
          SELECT COUNT(*)::int FROM coupon_redemptions cr
          LEFT JOIN orders o ON o.id = cr.order_id
          WHERE cr.coupon_code = c.code AND (o.status IS NULL OR o.status != 'cancelled')
        ), 0) AS usage_count
      FROM coupons c
      ORDER BY c.show_in_banner DESC, c.created_at DESC, c.code ASC
    `);
    res.json({
      coupons: result.rows.map((c) => ({
        code: String(c.code),
        description: String(c.description),
        descriptionBn: String(c.description_bn),
        type: String(c.type),
        value: Number(c.value),
        minSubtotal: Number(c.min_subtotal),
        maxDiscount: c.max_discount != null ? Number(c.max_discount) : undefined,
        active: Boolean(c.active),
        showInBanner: Boolean(c.show_in_banner),
        usageCount: Number(c.usage_count ?? 0),
        createdAt: c.created_at ? new Date(c.created_at).toISOString() : undefined,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/admin/coupons', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const code = String(b.code ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  const type = String(b.type ?? 'percent').trim();
  const value = Math.max(0, Math.round(Number(b.value ?? 0)));
  const minSubtotal = Math.max(0, Math.round(Number(b.minSubtotal ?? 0)));
  const maxDiscount =
    b.maxDiscount != null && Number(b.maxDiscount) > 0 ? Math.round(Number(b.maxDiscount)) : null;
  const showInBanner = Boolean(b.showInBanner);

  if (!code || code.length < 3) {
    res.status(400).json({ error: 'Promo code must be at least 3 alphanumeric characters.' });
    return;
  }
  if (!['percent', 'flat', 'free-delivery'].includes(type)) {
    res.status(400).json({ error: 'Invalid discount type.' });
    return;
  }
  if (type !== 'free-delivery' && value <= 0) {
    res.status(400).json({ error: 'Discount value must be greater than 0.' });
    return;
  }

  const autoDesc =
    type === 'percent'
      ? `${value}% off orders ৳${minSubtotal}+${maxDiscount ? ` (up to ৳${maxDiscount})` : ''}`
      : type === 'flat'
      ? `৳${value} flat discount on orders ৳${minSubtotal}+`
      : `Free delivery on orders ৳${minSubtotal}+`;
  const autoDescBn =
    type === 'percent'
      ? `৳${minSubtotal}+ অর্ডারে ${value}% ছাড়`
      : type === 'flat'
      ? `৳${minSubtotal}+ অর্ডারে ৳${value} ছাড়`
      : `৳${minSubtotal}+ অর্ডারে ফ্রি ডেলিভারি`;

  const description = String(b.description ?? '').trim() || autoDesc;
  const descriptionBn = String(b.descriptionBn ?? '').trim() || autoDescBn;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (showInBanner) {
      await client.query('UPDATE coupons SET show_in_banner = FALSE');
    }
    const inserted = await client.query(
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
         show_in_banner = EXCLUDED.show_in_banner
       RETURNING *`,
      [code, description, descriptionBn, type, value, minSubtotal, maxDiscount, showInBanner]
    );
    await client.query('COMMIT');
    const c = inserted.rows[0];
    res.status(201).json({
      coupon: {
        code: String(c.code),
        description: String(c.description),
        descriptionBn: String(c.description_bn),
        type: String(c.type),
        value: Number(c.value),
        minSubtotal: Number(c.min_subtotal),
        maxDiscount: c.max_discount != null ? Number(c.max_discount) : undefined,
        active: Boolean(c.active),
        showInBanner: Boolean(c.show_in_banner),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.patch('/admin/coupons/:code', requireAdmin, async (req, res) => {
  const code = String(req.params.code ?? '').trim().toUpperCase();
  const b = req.body ?? {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (b.showInBanner === true) {
      await client.query('UPDATE coupons SET show_in_banner = FALSE');
    }
    const result = await client.query(
      `UPDATE coupons SET
         active = COALESCE($1, active),
         show_in_banner = COALESCE($2, show_in_banner)
       WHERE code = $3
       RETURNING *`,
      [
        b.active !== undefined ? Boolean(b.active) : null,
        b.showInBanner !== undefined ? Boolean(b.showInBanner) : null,
        code,
      ]
    );
    await client.query('COMMIT');
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Promo code not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.delete('/admin/coupons/:code', requireAdmin, async (req, res) => {
  const code = String(req.params.code ?? '').trim().toUpperCase();
  try {
    await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/admin/orders', requireAdmin, async (_req, res) => {
  try {
    const [ordersRes, messagesRes] = await Promise.all([
      pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 150'),
      pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 50'),
    ]);

    const orderIds = ordersRes.rows.map((o) => o.id);
    const itemsRes =
      orderIds.length > 0
        ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds])
        : { rows: [] };

    const itemsByOrder = new Map<string, unknown[]>();
    for (const item of itemsRes.rows) {
      const oid = String(item.order_id);
      if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
      itemsByOrder.get(oid)!.push({
        productId: String(item.product_id),
        name: String(item.name),
        nameBn: String(item.name_bn),
        variantLabel: String(item.variant_label),
        imageUrl: String(item.image_url),
        unitPrice: Number(item.unit_price),
        quantity: Number(item.quantity),
      });
    }

    // Aggregate per-customer order count & lifetime spend across all returned orders
    const customerKey = (o: Record<string, unknown>) =>
      o.user_id
        ? `u:${o.user_id}`
        : o.customer_email
        ? `e:${String(o.customer_email).toLowerCase()}`
        : `p:${String(o.customer_phone)}`;

    const customerStats = new Map<string, { count: number; totalSpent: number }>();
    for (const o of ordersRes.rows) {
      const k = customerKey(o);
      const prev = customerStats.get(k) ?? { count: 0, totalSpent: 0 };
      prev.count += 1;
      if (o.status !== 'cancelled') {
        prev.totalSpent += Number(o.total);
      }
      customerStats.set(k, prev);
    }

    res.json({
      orders: ordersRes.rows.map((o) => {
        const k = customerKey(o);
        const cStat = customerStats.get(k) ?? { count: 1, totalSpent: Number(o.total) };
        return {
          id: String(o.id),
          orderId: String(o.order_number),
          customerKey: k,
          status: String(o.status),
          createdAt: new Date(o.created_at).toISOString(),
          customerName: String(o.customer_name),
          customerPhone: String(o.customer_phone),
          customerEmail: String(o.customer_email ?? ''),
          areaName: String(o.area_name),
          areaNameBn: o.area_name_bn ? String(o.area_name_bn) : undefined,
          address: String(o.address),
          city: String(o.city ?? 'Dhaka'),
          paymentMethod: String(o.payment_method),
          walletNumber: o.wallet_number ? String(o.wallet_number) : null,
          notes: o.notes ? String(o.notes) : null,
          deliverySlot: String(o.delivery_slot),
          subtotal: Number(o.subtotal),
          itemSavings: Number(o.item_savings ?? 0),
          couponDiscount: Number(o.coupon_discount ?? 0),
          deliveryFee: Number(o.delivery_fee),
          total: Number(o.total),
          couponCode: o.coupon_code ? String(o.coupon_code) : null,
          customerOrderCount: cStat.count,
          customerTotalSpent: cStat.totalSpent,
          items: itemsByOrder.get(String(o.id)) ?? [],
        };
      }),
      messages: messagesRes.rows.map((m) => ({
        id: Number(m.id),
        name: String(m.name),
        phone: String(m.phone),
        email: String(m.email ?? ''),
        message: String(m.message),
        createdAt: new Date(m.created_at).toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const status = String(req.body?.status ?? '').trim();
  const allowed = new Set(['pending', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled']);
  if (!allowed.has(status)) {
    res.status(400).json({ error: 'Invalid order status.' });
    return;
  }

  try {
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id::text = $2 OR order_number = $2 RETURNING id, order_number, status',
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (status === 'cancelled') {
      await pool.query('DELETE FROM coupon_redemptions WHERE order_id = $1', [result.rows[0].id]);
    }
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export { router as apiRouter };
