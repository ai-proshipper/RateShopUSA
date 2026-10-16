/**
 * Canada Post USA parcel limits (internal cm / kg).
 * Length is the longest side; girth = length + 2 × (width + height).
 */

const LB_TO_KG = 0.45359237;
const OZ_TO_KG = 0.028349523125;
const IN_TO_CM = 2.54;

/** @typedef {{ weightKg: number, lengthCm: number, widthCm: number, heightCm: number }} CanadaPostUsParcelMetrics */

export const CANADA_POST_US_SERVICE_LIMITS = {
  'USA.XP': {
    maxWeightKg: 30,
    maxSideCm: 150,
    maxLengthPlusGirthCm: 274,
    minLengthCm: 21,
    minWidthCm: 14,
    minHeightCm: 0.1,
  },
  'USA.EP': {
    maxWeightKg: 30,
    maxSideCm: 200,
    maxLengthPlusGirthCm: 274,
    minLengthCm: 21,
    minWidthCm: 14,
    minHeightCm: 0.5,
  },
};

export const CANADA_POST_US_OVERSIZE_NO_SERVICE_MSG =
  'No service for this package (exceeds Canada Post USA size/weight limits)';

export function inchesToCm1(inches) {
  return Math.round(Number(inches) * IN_TO_CM * 10) / 10;
}

export function packageWeightKg(pkg) {
  if (pkg?.weightLbs != null) {
    return Math.round(Number(pkg.weightLbs) * LB_TO_KG * 1000) / 1000;
  }
  if (pkg?.weightOz != null) {
    return Math.round(Number(pkg.weightOz) * OZ_TO_KG * 1000) / 1000;
  }
  if (pkg?.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'kg') {
    return Number(pkg.weight);
  }
  if (pkg?.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'lbs') {
    return Math.round(Number(pkg.weight) * LB_TO_KG * 1000) / 1000;
  }
  return NaN;
}

/**
 * Longest side = length (Canada Post convention).
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {[number, number, number]}
 */
export function sortCanadaPostUsSidesCm(a, b, c) {
  return [a, b, c].map(Number).sort((x, y) => y - x);
}

/**
 * @param {Record<string, unknown> | null | undefined} pkg
 * @returns {CanadaPostUsParcelMetrics | null}
 */
export function canadaPostUsParcelMetricsFromPackage(pkg) {
  if (!pkg) return null;
  const weightKg = packageWeightKg(pkg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

  const lengthIn = Number(pkg.lengthIn ?? pkg.length);
  const widthIn = Number(pkg.widthIn ?? pkg.width);
  const heightIn = Number(pkg.heightIn ?? pkg.height);
  if (![lengthIn, widthIn, heightIn].every((v) => Number.isFinite(v) && v > 0)) {
    return null;
  }

  const [lengthCm, widthCm, heightCm] = sortCanadaPostUsSidesCm(
    inchesToCm1(lengthIn),
    inchesToCm1(widthIn),
    inchesToCm1(heightIn),
  );
  return { weightKg, lengthCm, widthCm, heightCm };
}

/**
 * @param {CanadaPostUsParcelMetrics} metrics
 */
export function canadaPostUsLengthPlusGirthCm(metrics) {
  return metrics.lengthCm + 2 * (metrics.widthCm + metrics.heightCm);
}

/**
 * @param {string} serviceCode
 * @param {CanadaPostUsParcelMetrics} metrics
 */
export function canadaPostUsServiceAccepts(serviceCode, metrics) {
  const limits = CANADA_POST_US_SERVICE_LIMITS[String(serviceCode || '').toUpperCase()];
  if (!limits || !metrics) return true;

  if (metrics.weightKg > limits.maxWeightKg) return false;
  if (metrics.lengthCm > limits.maxSideCm) return false;
  if (metrics.widthCm > limits.maxSideCm) return false;
  if (metrics.heightCm > limits.maxSideCm) return false;
  if (canadaPostUsLengthPlusGirthCm(metrics) > limits.maxLengthPlusGirthCm) return false;
  if (metrics.lengthCm < limits.minLengthCm) return false;
  if (metrics.widthCm < limits.minWidthCm) return false;
  if (metrics.heightCm < limits.minHeightCm) return false;
  return true;
}

/**
 * True when every configured service with known limits (USA.EP / USA.XP) rejects
 * the parcel. Missing metrics → not oversize (cannot skip on size alone).
 * @param {string[]} serviceCodes
 * @param {CanadaPostUsParcelMetrics | null} metrics
 */
export function canadaPostUsParcelExceedsShoppedServices(serviceCodes, metrics) {
  if (!metrics) return false;
  const codes = (serviceCodes || []).map((c) => String(c || '').toUpperCase()).filter(Boolean);
  const limited = codes.filter((code) => CANADA_POST_US_SERVICE_LIMITS[code]);
  if (!limited.length) return false;
  return limited.every((code) => !canadaPostUsServiceAccepts(code, metrics));
}
