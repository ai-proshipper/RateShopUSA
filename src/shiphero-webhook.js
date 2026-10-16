/**
 * Convert ShipHero Generate Label Webhook payload to the USA shipment shape.
 * Customs values from ShipHero are USD. Postage / ranked totals stay CAD.
 */

/** @type {Record<string, string>} */
const COUNTRY_ALIASES = {
  CANADA: 'CA',
  CA: 'CA',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  USA: 'US',
  US: 'US',
};

/** Canadian provinces/territories + common aliases → ISO-3166-2 subdivision code. */
/** @type {Record<string, string>} */
const CA_PROVINCE_ALIASES = {
  AB: 'AB',
  ALBERTA: 'AB',
  BC: 'BC',
  'BRITISH COLUMBIA': 'BC',
  'COLOMBIE-BRITANNIQUE': 'BC',
  'COLOMBIE BRITANNIQUE': 'BC',
  MB: 'MB',
  MANITOBA: 'MB',
  NB: 'NB',
  'NEW BRUNSWICK': 'NB',
  'NOUVEAU-BRUNSWICK': 'NB',
  'NOUVEAU BRUNSWICK': 'NB',
  NL: 'NL',
  NF: 'NL',
  NFLD: 'NL',
  'NEWFOUNDLAND AND LABRADOR': 'NL',
  NEWFOUNDLAND: 'NL',
  LABRADOR: 'NL',
  'TERRE-NEUVE-ET-LABRADOR': 'NL',
  'TERRE NEUVE ET LABRADOR': 'NL',
  'TERRE-NEUVE': 'NL',
  'TERRE NEUVE': 'NL',
  NS: 'NS',
  'NOVA SCOTIA': 'NS',
  'NOUVELLE-ECOSSE': 'NS',
  'NOUVELLE ECOSSE': 'NS',
  NT: 'NT',
  NWT: 'NT',
  'NORTHWEST TERRITORIES': 'NT',
  'TERRITOIRES DU NORD-OUEST': 'NT',
  'TERRITOIRES DU NORD OUEST': 'NT',
  TNO: 'NT',
  NU: 'NU',
  NUNAVUT: 'NU',
  ON: 'ON',
  ONTARIO: 'ON',
  PE: 'PE',
  'PRINCE EDWARD ISLAND': 'PE',
  PEI: 'PE',
  'ILE-DU-PRINCE-EDOUARD': 'PE',
  'ILE DU PRINCE EDOUARD': 'PE',
  IPE: 'PE',
  QC: 'QC',
  PQ: 'QC',
  QUEBEC: 'QC',
  SK: 'SK',
  SASKATCHEWAN: 'SK',
  YT: 'YT',
  YUKON: 'YT',
  'YUKON TERRITORY': 'YT',
  'TERRITOIRE DU YUKON': 'YT',
};

/**
 * @param {unknown} country
 * @param {string} [fallback]
 */
export function normalizeCountryCode(country, fallback = '') {
  const raw = String(country ?? '').trim();
  if (!raw) return fallback;
  const key = raw.toUpperCase().replace(/\./g, '');
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  if (/^[A-Z]{2}$/.test(key)) return key;
  return raw.length === 2 ? raw.toUpperCase() : raw;
}

/**
 * @param {unknown} stateOrProvince
 * @param {unknown} [stateCode]
 */
export function normalizeProvinceCode(stateOrProvince, stateCode) {
  const code = String(stateCode ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;

  const raw = String(stateOrProvince ?? '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (CA_PROVINCE_ALIASES[key]) return CA_PROVINCE_ALIASES[key];
  if (/^[A-Z]{2}$/.test(key)) return key;
  return raw;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mapAddress(addr, fallbackName, defaultCountry) {
  if (!addr || typeof addr !== 'object') {
    throw new Error('Missing address on label request');
  }

  const a = /** @type {Record<string, unknown>} */ (addr);
  const residential = a.is_residential ?? a.residential;
  return {
    name: String(a.name || fallbackName),
    company: a.company_name || a.company ? String(a.company_name || a.company) : undefined,
    address1: String(a.address_1 || a.address1 || ''),
    address2: a.address_2 || a.address2 ? String(a.address_2 || a.address2) : undefined,
    city: String(a.city || ''),
    state: normalizeProvinceCode(a.state || a.province, a.state_code),
    postalCode: String(a.zip || a.postal_code || ''),
    country: normalizeCountryCode(a.country || a.country_code, defaultCountry),
    phone: a.phone ? String(a.phone) : undefined,
    email: a.email ? String(a.email) : undefined,
    is_residential: residential == null ? undefined : Boolean(residential),
  };
}

/**
 * Flatten ShipHero packages[].line_items. Customs currency is always USD.
 * @param {Record<string, unknown>} body
 */
export function extractLineItems(body) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const packages = Array.isArray(body?.packages) ? body.packages : [];
  for (const pkg of packages) {
    const lineItems = Array.isArray(pkg?.line_items) ? pkg.line_items : [];
    for (const item of lineItems) {
      if (!item || typeof item !== 'object') continue;
      const title = String(
        item.name || item.product_name || item.customs_description || item.sku || 'Merchandise',
      ).trim();
      const customsValue = Number(item.customs_value);
      const price = Number(item.price);
      const value =
        Number.isFinite(customsValue) && customsValue > 0
          ? customsValue
          : Number.isFinite(price) && price > 0
            ? price
            : null;
      out.push({
        title: title || 'Merchandise',
        sku: item.sku != null ? String(item.sku) : undefined,
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        value: value != null ? value : undefined,
        currency: 'USD',
        hs_code: item.tariff_code != null ? String(item.tariff_code) : undefined,
        country_of_origin: String(item.country_of_manufacture || item.country_of_origin || '')
          .trim()
          .slice(0, 2)
          .toUpperCase() || undefined,
        customs_description: String(
          item.customs_description || item.name || title || 'Merchandise',
        ).trim(),
      });
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} body
 */
export function parseGenerateLabelPayload(body) {
  const from = mapAddress(body.from_address, 'Ship From', 'CA');
  const to = mapAddress(body.to_address, 'Recipient', '');

  if (to.country !== 'US') {
    throw new Error(
      `USA Rate Shop only handles US destinations (got ${to.country || 'missing'}). ` +
        'Canada dest belongs on the CAD Rate Shop path.',
    );
  }

  const packages = (body.packages || []).map((pkg, i) => ({
    name: pkg.name || pkg.box_name || `Package ${i + 1}`,
    weightOz: Number(pkg.weight_in_oz) || 0,
    lengthIn: num(pkg.length),
    widthIn: num(pkg.width),
    heightIn: num(pkg.height),
    package_contents: pkg.name || pkg.box_name || pkg.package_contents || undefined,
  }));

  if (packages.length === 0) {
    throw new Error('No packages in label request');
  }

  if (packages.length > 1) {
    throw new Error('Rate Shop supports one package per shipment only');
  }

  if (packages.some((p) => !p.weightOz)) {
    throw new Error('Package weight is required before rate shopping');
  }

  const items = extractLineItems(body);
  if (packages[0] && !packages[0].package_contents && items[0]?.title) {
    packages[0].package_contents = items[0].title;
  }

  return {
    orderId: body.order_id != null ? String(body.order_id) : undefined,
    orderNumber: body.order_number != null ? String(body.order_number) : undefined,
    shopName: body.shop_name != null ? String(body.shop_name) : undefined,
    from,
    to,
    packages,
    items,
    currency: 'CAD',
    customsCurrency: 'USD',
    region: from.country === 'CA' ? from.state || undefined : undefined,
    shipHeroMethod: body.shipping_method != null ? String(body.shipping_method) : undefined,
  };
}
