import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ensureMediaBucket, getPublicMediaUrl, supabaseAdmin, MEDIA_BUCKET } from './db';

interface AssetEntry {
  key: string;
  filename: string;
  kind: 'banner' | 'cutout';
}

const ASSETS: AssetEntry[] = [
  { key: 'heroBanner', filename: 'hero_avado_grocery_1794711423297.jpg', kind: 'banner' },
  { key: 'promoHarvest', filename: 'promo_harvest_banner_1794711423918.jpg', kind: 'banner' },
  { key: 'catFruits', filename: 'cutout_cat_fruits_1794712851330.jpg', kind: 'cutout' },
  { key: 'catVegetables', filename: 'cutout_cat_vegetables_1794712852765.jpg', kind: 'cutout' },
  { key: 'catFishMeat', filename: 'cutout_cat_fish_meat_1794712851944.jpg', kind: 'cutout' },
  { key: 'catRiceGrains', filename: 'cutout_cat_rice_grains_1794712852806.jpg', kind: 'cutout' },
  { key: 'catOilSpices', filename: 'cutout_cat_oil_spices_1794712852954.jpg', kind: 'cutout' },
  { key: 'catDairyEggs', filename: 'cutout_cat_dairy_eggs_1794712853354.jpg', kind: 'cutout' },
  { key: 'catSnacksBakery', filename: 'cutout_cat_snacks_bakery_1794712853935.jpg', kind: 'cutout' },
  { key: 'catBeverages', filename: 'cutout_cat_beverages_1794712854549.jpg', kind: 'cutout' },
  { key: 'catFrozenFoods', filename: 'cutout_cat_frozen_foods_1794712854540.jpg', kind: 'cutout' },
  { key: 'catHousehold', filename: 'cutout_cat_household_1794712855476.jpg', kind: 'cutout' },
  { key: 'catSaucesPickles', filename: 'cutout_cat_sauces_pickles_1794712855260.jpg', kind: 'cutout' },
  { key: 'catCandyChocolate', filename: 'cutout_cat_candy_chocolate_1794712856054.jpg', kind: 'cutout' },
  { key: 'prodMango', filename: 'cutout_prod_mango_1794712856072.jpg', kind: 'cutout' },
  { key: 'prodPotatoOnion', filename: 'cutout_prod_potato_onion_1794712855923.jpg', kind: 'cutout' },
  { key: 'prodHilsaFish', filename: 'cutout_prod_hilsa_fish_1794712856684.jpg', kind: 'cutout' },
  { key: 'prodBeefChicken', filename: 'cutout_prod_beef_chicken_1794712856641.jpg', kind: 'cutout' },
  { key: 'prodRiceBag', filename: 'cutout_prod_rice_bag_1794712857483.jpg', kind: 'cutout' },
  { key: 'prodOilBottle', filename: 'cutout_prod_oil_bottle_1794712858351.jpg', kind: 'cutout' },
  { key: 'prodMustardOil', filename: 'cutout_prod_mustard_oil_1794712857886.jpg', kind: 'cutout' },
  { key: 'prodMilkCarton', filename: 'cutout_prod_milk_carton_1794712859962.jpg', kind: 'cutout' },
  { key: 'prodMishtiDoi', filename: 'cutout_prod_mishti_doi_1794712858541.jpg', kind: 'cutout' },
  { key: 'prodButterGhee', filename: 'cutout_prod_butter_ghee_1794712859028.jpg', kind: 'cutout' },
  { key: 'prodBrownEggs', filename: 'cutout_prod_brown_eggs_1794712858834.jpg', kind: 'cutout' },
  { key: 'prodTeaBiscuits', filename: 'cutout_prod_tea_biscuits_1794712860462.jpg', kind: 'cutout' },
];

async function run() {
  if (!supabaseAdmin) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  }

  await ensureMediaBucket();

  const srcDir = path.resolve(process.cwd(), 'frontend/src/assets/images');
  let totalRawBytes = 0;
  let totalWebpBytes = 0;
  const urlMap: Record<string, string> = {};

  for (const entry of ASSETS) {
    const filePath = path.join(srcDir, entry.filename);
    const rawBuffer = await fs.readFile(filePath);
    totalRawBytes += rawBuffer.byteLength;

    const webpBuffer =
      entry.kind === 'banner'
        ? await sharp(rawBuffer)
            .resize({ width: 1200, withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer()
        : await sharp(rawBuffer)
            .resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer();

    totalWebpBytes += webpBuffer.byteLength;

    const storagePath = `catalog/${entry.key}.webp`;
    const { error } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, webpBuffer, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: true,
      });

    if (error) {
      throw new Error(`Upload failed for ${entry.key}: ${error.message}`);
    }

    urlMap[entry.key] = getPublicMediaUrl(storagePath);
    console.log(
      `✓ ${entry.key}: ${(rawBuffer.byteLength / 1024).toFixed(0)}KB -> ${(
        webpBuffer.byteLength / 1024
      ).toFixed(0)}KB`
    );
  }

  console.log(
    `\nTotal compressed: ${(totalRawBytes / (1024 * 1024)).toFixed(2)} MB -> ${(
      totalWebpBytes / 1024
    ).toFixed(0)} KB (${Math.round((1 - totalWebpBytes / totalRawBytes) * 100)}% reduction)`
  );

  const lines = [
    '// Fast WebP CDN URLs hosted on Supabase Storage (compressed from original assets)',
    'export const GROCERY_IMAGES = {',
    ...Object.entries(urlMap).map(([k, v]) => `  ${k}: '${v}',`),
    '} as const;',
    '',
  ];

  const targetImagesTs = path.resolve(process.cwd(), 'frontend/src/data/images.ts');
  await fs.writeFile(targetImagesTs, lines.join('\n'), 'utf8');
  console.log('Updated frontend/src/data/images.ts with Supabase WebP URLs.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
