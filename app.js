(function () {
  "use strict";

  const STORAGE_KEY = "shopeeDashboardSnapshots:v1";
  const CORE_VERSION = "1.0.0";
  const APP_BUILD_VERSION = "trend-charts-v14";
  const SCRIPT_BUILD_VERSION = typeof document !== "undefined" && document.currentScript ? document.currentScript.dataset.appBuild || "" : "";
  const FFMPEG_VERSION = "0.12.15";
  const FFMPEG_CORE_VERSION = "0.12.10";
  const FFMPEG_LOCAL_SCRIPT = "./vendor/ffmpeg/ffmpeg.js";
  const FFMPEG_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
  const VIDEO_SIZE_WARNING_BYTES = 100 * 1024 * 1024;
  const VIDEO_DURATION_WARNING_SECONDS = 180;
  const QUALITY_PRESETS = {
    balanced: { label: "Balanced Fast", crf: "24", encoderPreset: "superfast", note: "Laju dengan quality masih okay" },
    small: { label: "Max Speed", crf: "28", encoderPreset: "ultrafast", note: "Paling laju, file boleh besar/quality turun" },
    high: { label: "Better Quality", crf: "22", encoderPreset: "veryfast", note: "Lebih cantik, lebih lambat" }
  };
  const videoState = {
    queue: [],
    selectedId: "",
    inputName: "",
    outputName: "",
    ffmpeg: null,
    ffmpegScript: null,
    loadingEngine: null,
    converting: false,
    activeIndex: -1
  };

  const ADS_COLUMNS = ["Ad name", "Amount spent (MYR)", "Link clicks"];
  const COMMISSION_COLUMNS = ["Order id", "Affiliate Net Commission(RM)", "Sub_id4"];

  const money = new Intl.NumberFormat("ms-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const num = new Intl.NumberFormat("ms-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

  const decimal = new Intl.NumberFormat("ms-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function cleanHeader(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim();
  }

  function normalizeKey(value) {
    return cleanHeader(value).toLowerCase();
  }

  function parseCsv(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      const next = source[i + 1];

      if (char === "\"") {
        if (inQuotes && next === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
        continue;
      }

      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(field);
        field = "";
        if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
        row = [];
        continue;
      }

      field += char;
    }

    row.push(field);
    if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);

    const headers = (rows.shift() || []).map(cleanHeader);
    const records = rows.map((cells) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] == null ? "" : String(cells[index]).trim();
      });
      return record;
    });

    return { headers, rows: records };
  }

  function hasColumns(headers, required) {
    const lookup = new Set(headers.map(normalizeKey));
    return required.every((column) => lookup.has(normalizeKey(column)));
  }

  function detectFile(parsed) {
    if (hasColumns(parsed.headers, ADS_COLUMNS)) return "ads";
    if (hasColumns(parsed.headers, COMMISSION_COLUMNS)) return "commission";
    return "unknown";
  }

  function getField(row, names) {
    const candidates = Array.isArray(names) ? names : [names];
    const keys = Object.keys(row || {});
    for (const name of candidates) {
      const wanted = normalizeKey(name);
      const match = keys.find((key) => normalizeKey(key) === wanted);
      if (match) return row[match];
    }
    return "";
  }

  function parseNumber(value) {
    if (value == null) return 0;
    const raw = String(value).trim();
    if (!raw || raw === "-") return 0;
    const negative = raw.startsWith("(") && raw.endsWith(")");
    const cleaned = raw.replace(/[(),%A-Za-z\s]/g, "").replace(/RM/g, "");
    const parsed = Number.parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;
    return negative ? -parsed : parsed;
  }

  function safeDivide(a, b) {
    return b ? a / b : 0;
  }

  function normalizeAdNo(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const withoutDecimal = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    const parsed = Number.parseInt(withoutDecimal, 10);
    if (Number.isFinite(parsed) && String(parsed) === withoutDecimal.replace(/^0+/, "") || withoutDecimal === "0") {
      return String(parsed);
    }
    if (/^\d+$/.test(withoutDecimal)) return String(Number.parseInt(withoutDecimal, 10));
    return withoutDecimal;
  }

  function normalizeSubId4(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const withoutDecimal = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    if (!/^\d+$/.test(withoutDecimal)) return "";
    return String(Number.parseInt(withoutDecimal, 10));
  }

  function simpleHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function fingerprintRows(headers, rows) {
    const sortedHeaders = headers.map(cleanHeader).sort((a, b) => a.localeCompare(b));
    const canonicalRows = rows
      .map((row) => sortedHeaders.map((header) => String(row[header] || "").trim()).join("\u001f"))
      .sort();
    return simpleHash(`${sortedHeaders.join("\u001e")}\u001d${canonicalRows.join("\u001c")}`);
  }

  function commissionKey(row) {
    const orderId = String(getField(row, "Order id") || "").trim();
    const itemId = String(getField(row, "Item id") || "").trim();
    const itemName = String(getField(row, "Item Name") || "").trim().toLowerCase().replace(/\s+/g, " ");
    const purchase = parseNumber(getField(row, "Purchase Value(RM)")).toFixed(4);
    const commission = parseNumber(getField(row, "Affiliate Net Commission(RM)")).toFixed(4);
    if (orderId && itemId) return `order-item|${orderId}|${itemId}|${purchase}|${commission}`;
    if (orderId && itemName) return `order-name|${orderId}|${itemName}|${purchase}|${commission}`;
    const conversionId = String(getField(row, "Conversion id") || "").trim();
    if (orderId || conversionId) return `order-conversion|${orderId}|${conversionId}|${purchase}|${commission}`;
    return simpleHash(JSON.stringify(row));
  }

  function commissionRowQuality(row) {
    const keys = Object.keys(row || {});
    const nonEmpty = keys.filter((key) => String(row[key] || "").trim()).length;
    let quality = nonEmpty;
    if (getField(row, "Affiliate Item Status") || getField(row, "Order Status")) quality += 30;
    if (getField(row, "Attribution Type")) quality += 12;
    if (getField(row, "Complete Time")) quality += 8;
    if (getField(row, "Shop id")) quality += 5;
    return quality;
  }

  function duplicateOrderId(row) {
    return String(getField(row, "Order id") || "").trim() || "unknown-order";
  }

  function groupInit() {
    return {
      orders: new Set(),
      items: 0,
      purchaseValue: 0,
      expectedCommission: 0,
      completedCommission: 0,
      pendingCommission: 0,
      completedOrders: new Set(),
      pendingOrders: new Set()
    };
  }

  function addCommissionGroup(group, row, status) {
    const orderId = String(getField(row, "Order id") || "").trim();
    const purchase = parseNumber(getField(row, "Purchase Value(RM)"));
    const commission = parseNumber(getField(row, "Affiliate Net Commission(RM)"));
    group.items += 1;
    group.purchaseValue += purchase;
    group.expectedCommission += commission;
    if (orderId) group.orders.add(orderId);
    if (status === "completed") {
      group.completedCommission += commission;
      if (orderId) group.completedOrders.add(orderId);
    }
    if (status === "pending") {
      group.pendingCommission += commission;
      if (orderId) group.pendingOrders.add(orderId);
    }
  }

  function statusType(row) {
    const status = String(getField(row, ["Affiliate Item Status", "Order Status"]) || "").trim().toLowerCase();
    if (status.includes("cancel")) return "cancelled";
    if (status.includes("complete")) return "completed";
    if (status.includes("pending")) return "pending";
    return status || "unknown";
  }

  function groupBy(rows, keyFn, rowFn) {
    const map = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!key) return;
      if (!map.has(key)) map.set(key, groupInit());
      rowFn(map.get(key), row);
    });
    return map;
  }

  function serializeGroup(key, group, extra = {}) {
    const purchaseValue = group.purchaseValue;
    const expectedCommission = group.expectedCommission;
    return {
      key,
      orders: group.orders.size,
      items: group.items,
      purchaseValue,
      expectedCommission,
      completedCommission: group.completedCommission,
      pendingCommission: group.pendingCommission,
      avgCommissionRate: safeDivide(expectedCommission, purchaseValue),
      ...extra
    };
  }

  function actionForAd(row, totalSpend) {
    const trafficClicks = row.trafficClicks || 0;
    if (!row.spend && row.expectedCommission > 0) {
      return { label: "Tracking Only", tone: "tracking", note: "Ada komisyen tetapi tiada Ads row dipadankan." };
    }
    if (row.commissionRoas >= 1 && (row.orders >= 2 || trafficClicks >= 100)) {
      return { label: "Scale", tone: "scale", note: "ROAS komisyen sudah lepas break-even." };
    }
    if (row.expectedCommission > 0) {
      const highSpend = row.spend >= Math.max(10, totalSpend * 0.1);
      if (row.commissionRoas < 0.2 && highSpend) {
        return { label: "Cut Budget", tone: "cut", note: "Ada komisyen tetapi spend terlalu berat." };
      }
      if (row.commissionRoas >= 0.4) {
        return { label: "Protect/Test More", tone: "protect", note: "Relatif kuat, tambah data sebelum scale." };
      }
      return { label: "Optimize", tone: "optimize", note: "Ada order, tapi belum cukup dekat break-even." };
    }
    if (row.spend >= 5 || trafficClicks >= 40) {
      return { label: "Pause/Kill", tone: "pause", note: "Spend/klik sudah jalan tanpa komisyen." };
    }
    return { label: "Observe", tone: "observe", note: "Data masih kecil." };
  }

  function buildCasingIssues(rows, field) {
    const variants = new Map();
    rows.forEach((row) => {
      const value = String(getField(row, field) || "").trim();
      if (!value) return;
      const key = value.toLowerCase();
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(value);
    });
    return [...variants.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([key, set]) => ({ field, key, variants: [...set] }));
  }

  function parseDateTime(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const [, year, month, day, hour, minute, second = "0"] = match;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
      return Number.isFinite(date.getTime()) ? date : null;
    }
    const fallback = new Date(raw);
    return Number.isFinite(fallback.getTime()) ? fallback : null;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function buildHoldAnalysis(rows) {
    const orders = new Map();
    let missingTimeRows = 0;
    let invalidTimeOrders = 0;
    const buckets = [
      { key: "0-15 min", maxMs: 15 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "15 min-1 jam", maxMs: 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "1-6 jam", maxMs: 6 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "6-24 jam", maxMs: 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "1-3 hari", maxMs: 3 * 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "3-7 hari", maxMs: 7 * 24 * 60 * 60 * 1000, orders: 0, purchaseValue: 0, expectedCommission: 0 },
      { key: "7 hari+", maxMs: Infinity, orders: 0, purchaseValue: 0, expectedCommission: 0 }
    ];

    rows.forEach((row) => {
      const clickTime = parseDateTime(getField(row, "Click Time"));
      const orderTime = parseDateTime(getField(row, "Order Time"));
      if (!clickTime || !orderTime) {
        missingTimeRows += 1;
        return;
      }
      const orderId = String(getField(row, "Order id") || commissionKey(row)).trim();
      const current = orders.get(orderId) || {
        orderId,
        clickTime,
        orderTime,
        purchaseValue: 0,
        expectedCommission: 0,
        items: 0
      };
      if (clickTime.getTime() < current.clickTime.getTime()) current.clickTime = clickTime;
      if (orderTime.getTime() < current.orderTime.getTime()) current.orderTime = orderTime;
      current.purchaseValue += parseNumber(getField(row, "Purchase Value(RM)"));
      current.expectedCommission += parseNumber(getField(row, "Affiliate Net Commission(RM)"));
      current.items += 1;
      orders.set(orderId, current);
    });

    const durations = [];
    const invalidOrders = [];
    const validOrders = [];
    orders.forEach((order) => {
      const holdMs = order.orderTime.getTime() - order.clickTime.getTime();
      if (holdMs < 0) {
        invalidTimeOrders += 1;
        invalidOrders.push(order);
        return;
      }
      durations.push(holdMs);
      validOrders.push({ ...order, holdMs });
      const bucket = buckets.find((item) => holdMs <= item.maxMs) || buckets[buckets.length - 1];
      bucket.orders += 1;
      bucket.purchaseValue += order.purchaseValue;
      bucket.expectedCommission += order.expectedCommission;
    });

    const totalOrders = validOrders.length;
    const totalCommission = validOrders.reduce((sum, order) => sum + order.expectedCommission, 0);
    const totalPurchaseValue = validOrders.reduce((sum, order) => sum + order.purchaseValue, 0);
    const sameHourOrders = validOrders.filter((order) => order.holdMs <= 60 * 60 * 1000).length;
    const sameDayOrders = validOrders.filter((order) => order.holdMs <= 24 * 60 * 60 * 1000).length;
    const delayedOrders = validOrders.filter((order) => order.holdMs > 24 * 60 * 60 * 1000).length;

    return {
      totalOrders,
      missingTimeRows,
      invalidTimeOrders,
      avgMs: safeDivide(durations.reduce((sum, value) => sum + value, 0), durations.length),
      medianMs: median(durations),
      shortestMs: durations.length ? Math.min(...durations) : 0,
      longestMs: durations.length ? Math.max(...durations) : 0,
      sameHourRate: safeDivide(sameHourOrders, totalOrders),
      sameDayRate: safeDivide(sameDayOrders, totalOrders),
      delayedRate: safeDivide(delayedOrders, totalOrders),
      totalPurchaseValue,
      totalCommission,
      buckets: buckets.map((bucket) => ({
        key: bucket.key,
        orders: bucket.orders,
        purchaseValue: bucket.purchaseValue,
        expectedCommission: bucket.expectedCommission,
        rate: safeDivide(bucket.orders, totalOrders),
        commissionShare: safeDivide(bucket.expectedCommission, totalCommission),
        purchaseValueShare: safeDivide(bucket.purchaseValue, totalPurchaseValue)
      })),
      invalidOrders: invalidOrders.map((order) => order.orderId)
    };
  }

  function isBlank(value) {
    return String(value == null ? "" : value).trim() === "";
  }

  function isZeroId(value) {
    const raw = String(value == null ? "" : value).trim();
    return !raw || raw === "0" || raw === "0.0";
  }

  function rawDigits(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const clean = raw.endsWith(".0") ? raw.slice(0, -2) : raw;
    return /^\d+$/.test(clean) ? clean : "";
  }

  function isMetaSummaryRow(row, headers) {
    if (!hasColumns(headers || [], ["Campaign ID", "Ad set ID", "Ad ID"])) return false;
    const idsAreZero = ["Campaign ID", "Ad set ID", "Ad ID"].every((field) => isZeroId(getField(row, field)));
    const namesAreBlank = ["Ad name", "Campaign name", "Ad set name"].every((field) => isBlank(getField(row, field)));
    const hasTotalMetric = ["Amount spent (MYR)", "Impressions", "Reach", "Clicks (all)"]
      .some((field) => parseNumber(getField(row, field)) > 0);
    return idsAreZero && namesAreBlank && hasTotalMetric;
  }

  function emptyAdsStats() {
    return {
      spend: 0,
      impressions: 0,
      reach: 0,
      linkClicks: 0,
      clicksAll: 0,
      outboundClicks: 0,
      video25: 0,
      video50: 0,
      video75: 0,
      video95: 0,
      video100: 0,
      videoAverageTimeWeighted: 0,
      videoAverageTimeImpressions: 0,
      threeSecondRateWeighted: 0,
      threeSecondRateImpressions: 0,
      thruPlayCostWeighted: 0,
      thruPlayCostPlays: 0,
      rows: 0
    };
  }

  function addAdsStats(target, row) {
    const impressions = parseNumber(getField(row, "Impressions"));
    const video25 = parseNumber(getField(row, "Video plays at 25%"));
    const video100 = parseNumber(getField(row, "Video plays at 100%"));
    const avgTime = parseNumber(getField(row, "Video average play time"));
    const threeSecondRate = parseNumber(getField(row, "3-second video plays rate per impressions"));
    const thruPlayCost = parseNumber(getField(row, "Cost per ThruPlay (MYR)"));
    target.spend += parseNumber(getField(row, "Amount spent (MYR)"));
    target.impressions += impressions;
    target.reach += parseNumber(getField(row, "Reach"));
    target.linkClicks += parseNumber(getField(row, "Link clicks"));
    target.clicksAll += parseNumber(getField(row, "Clicks (all)"));
    target.outboundClicks += parseNumber(getField(row, "Outbound clicks"));
    target.video25 += video25;
    target.video50 += parseNumber(getField(row, "Video plays at 50%"));
    target.video75 += parseNumber(getField(row, "Video plays at 75%"));
    target.video95 += parseNumber(getField(row, "Video plays at 95%"));
    target.video100 += video100;
    target.videoAverageTimeWeighted += avgTime * impressions;
    target.videoAverageTimeImpressions += impressions;
    target.threeSecondRateWeighted += threeSecondRate * impressions;
    target.threeSecondRateImpressions += impressions;
    target.thruPlayCostWeighted += thruPlayCost * video100;
    target.thruPlayCostPlays += video100;
    target.rows += 1;
  }

  function adsMetrics(stats, flags) {
    const outboundAvailable = flags && flags.outboundAvailable;
    const clicksAllAvailable = flags && flags.clicksAllAvailable;
    const trafficClicks = outboundAvailable ? stats.outboundClicks : stats.linkClicks;
    return {
      ...stats,
      clicksAllAvailable,
      outboundAvailable,
      ctrLink: safeDivide(stats.linkClicks, stats.impressions),
      linkClickRate: clicksAllAvailable ? safeDivide(stats.linkClicks, stats.clicksAll) : 0,
      cpcLink: safeDivide(stats.spend, stats.linkClicks),
      outboundCtr: outboundAvailable ? safeDivide(stats.outboundClicks, stats.impressions) : 0,
      outboundCpc: outboundAvailable ? safeDivide(stats.spend, stats.outboundClicks) : 0,
      linkOutboundGap: outboundAvailable ? stats.linkClicks - stats.outboundClicks : 0,
      trafficClicks,
      trafficCtr: outboundAvailable ? safeDivide(stats.outboundClicks, stats.impressions) : safeDivide(stats.linkClicks, stats.impressions),
      trafficCpc: safeDivide(stats.spend, trafficClicks),
      trafficSource: outboundAvailable ? "outbound" : "link",
      cpm: safeDivide(stats.spend, stats.impressions) * 1000,
      frequency: safeDivide(stats.impressions, stats.reach),
      videoAvgTime: safeDivide(stats.videoAverageTimeWeighted, stats.videoAverageTimeImpressions),
      threeSecondRate: safeDivide(stats.threeSecondRateWeighted, stats.threeSecondRateImpressions) / 100,
      videoCompletionRate: safeDivide(stats.video100, stats.video25),
      videoClickRate: safeDivide(trafficClicks, stats.video25),
      costPerCompletedView: safeDivide(stats.spend, stats.video100),
      costPerThruPlay: safeDivide(stats.thruPlayCostWeighted, stats.thruPlayCostPlays)
    };
  }

  function adsIdentity(row) {
    const adNo = normalizeAdNo(getField(row, "Ad name")) || "Unknown";
    const adId = rawDigits(getField(row, "Ad ID"));
    const adSetId = rawDigits(getField(row, "Ad set ID"));
    const campaignId = rawDigits(getField(row, "Campaign ID"));
    return {
      adNo,
      adId,
      adName: String(getField(row, "Ad name") || adNo).trim() || adNo,
      adSetId,
      adSetName: String(getField(row, "Ad set name") || "Unknown Ad Set").trim() || "Unknown Ad Set",
      campaignId,
      campaignName: String(getField(row, "Campaign name") || "Unknown Campaign").trim() || "Unknown Campaign"
    };
  }

  function dateKeyFromDate(date) {
    if (!date || !Number.isFinite(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function adsDateKey(row) {
    const raw = String(getField(row, "Reporting starts") || "").trim();
    return raw.match(/^\d{4}-\d{2}-\d{2}/) ? raw.slice(0, 10) : "";
  }

  function orderDateKey(row) {
    return dateKeyFromDate(parseDateTime(getField(row, "Order Time")));
  }

  function periodKey(dateKey, mode) {
    if (!dateKey) return "";
    const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
    if (!year || !month || !day) return "";
    if (mode === "monthly") return `${year}-${String(month).padStart(2, "0")}`;
    if (mode === "weekly") {
      const date = new Date(year, month - 1, day);
      const dayOfWeek = date.getDay() || 7;
      const start = new Date(date);
      start.setDate(date.getDate() - dayOfWeek + 1);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return `${dateKeyFromDate(start)} - ${dateKeyFromDate(end)}`;
    }
    return dateKey;
  }

  function sortPeriodKey(key) {
    return String(key || "").slice(0, 10);
  }

  function dateRangeText(keys) {
    const clean = [...new Set((keys || []).filter(Boolean))].sort();
    if (!clean.length) return "-";
    return clean.length === 1 ? clean[0] : `${clean[0]} sampai ${clean[clean.length - 1]}`;
  }

  function groupAdsRows(rows, keyFn, labelFn, flags) {
    const map = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!key) return;
      const current = map.get(key) || { key, label: labelFn(row), stats: emptyAdsStats() };
      addAdsStats(current.stats, row);
      map.set(key, current);
    });
    return [...map.values()].map((item) => ({ key: item.key, label: item.label, ...adsMetrics(item.stats, flags) }));
  }

  function addDimensionCommission(row, target) {
    addCommissionGroup(target, row, statusType(row));
  }

  function dimensionAction(row, totalSpend) {
    return actionForAd(row, totalSpend);
  }

  function serializeDimensionRows(rows, commissionMaps, totalSpend) {
    return rows.map((row) => {
      const group = commissionMaps.get(row.key) || groupInit();
      const trafficClicks = row.trafficClicks;
      const result = {
        ...row,
        orders: group.orders.size,
        items: group.items,
        purchaseValue: group.purchaseValue,
        expectedCommission: group.expectedCommission,
        completedCommission: group.completedCommission,
        pendingCommission: group.pendingCommission,
        avgCommissionRate: safeDivide(group.expectedCommission, group.purchaseValue),
        commissionRoas: safeDivide(group.expectedCommission, row.spend),
        gmvRoas: safeDivide(group.purchaseValue, row.spend),
        roi: safeDivide(group.expectedCommission - row.spend, row.spend),
        epc: safeDivide(group.expectedCommission, trafficClicks),
        cpa: safeDivide(row.spend, group.orders.size),
        orderCvr: safeDivide(group.orders.size, trafficClicks)
      };
      result.action = dimensionAction(result, totalSpend);
      return result;
    }).sort((a, b) => b.spend - a.spend);
  }

  function computeAnalysis(adsRows, commissionRows, meta) {
    const adsByAd = new Map();
    const adIdToAdNo = new Map();
    const adIdToKeys = new Map();
    const adNoToCampaignKeys = new Map();
    const adNoToAdSetKeys = new Map();
    const adNoToAdKeys = new Map();
    const missingClicksAllFiles = meta.missingClicksAllFiles || [];
    const missingOutboundFiles = meta.missingOutboundFiles || [];
    const clicksAllAvailable = adsRows.length > 0 && !missingClicksAllFiles.length;
    const outboundAvailable = adsRows.length > 0 && !missingOutboundFiles.length;
    const flags = { clicksAllAvailable, outboundAvailable };
    const adsTotalStats = emptyAdsStats();

    function rememberAdSet(map, adNo, value) {
      if (!adNo || !value) return;
      if (!map.has(adNo)) map.set(adNo, new Set());
      map.get(adNo).add(value);
    }

    adsRows.forEach((row) => {
      const identity = adsIdentity(row);
      const campaignKey = identity.campaignId || identity.campaignName;
      const adSetKey = identity.adSetId || identity.adSetName;
      const adKey = identity.adId || identity.adNo;
      const current = adsByAd.get(identity.adNo) || { adNo: identity.adNo, stats: emptyAdsStats() };
      addAdsStats(current.stats, row);
      adsByAd.set(identity.adNo, current);
      addAdsStats(adsTotalStats, row);
      rememberAdSet(adNoToCampaignKeys, identity.adNo, campaignKey);
      rememberAdSet(adNoToAdSetKeys, identity.adNo, adSetKey);
      rememberAdSet(adNoToAdKeys, identity.adNo, adKey);
      if (identity.adId) {
        adIdToAdNo.set(identity.adId, identity.adNo);
        adIdToKeys.set(identity.adId, { campaignKey, adSetKey, adKey });
      }
    });

    const adsTotals = adsMetrics(adsTotalStats, flags);

    const expectedRows = [];
    const cancelledRows = [];
    const unmappedRows = [];

    function resolveCommissionAd(row) {
      const raw = rawDigits(getField(row, "Sub_id4"));
      if (raw && adIdToAdNo.has(raw)) {
        return { adNo: adIdToAdNo.get(raw), adId: raw, source: "adId" };
      }
      const adNo = normalizeSubId4(getField(row, "Sub_id4"));
      if (adNo) return { adNo, adId: "", source: "adNo" };
      return { adNo: "", adId: "", source: "unmapped" };
    }

    commissionRows.forEach((row) => {
      const status = statusType(row);
      if (status === "cancelled") {
        cancelledRows.push(row);
        return;
      }
      expectedRows.push(row);
      const subid = String(getField(row, "Sub_id4") || "").trim();
      if (subid && !resolveCommissionAd(row).adNo) unmappedRows.push(row);
    });

    const totalsGroup = groupInit();
    expectedRows.forEach((row) => addCommissionGroup(totalsGroup, row, statusType(row)));

    const commissionTotals = serializeGroup("Total", totalsGroup, {
      cancelledItems: cancelledRows.length,
      cancelledOrders: new Set(cancelledRows.map((row) => getField(row, "Order id")).filter(Boolean)).size
    });

    const commissionByAd = groupBy(
      expectedRows,
      (row) => resolveCommissionAd(row).adNo,
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const campaignAds = groupAdsRows(
      adsRows,
      (row) => {
        const identity = adsIdentity(row);
        return identity.campaignId || identity.campaignName;
      },
      (row) => {
        const identity = adsIdentity(row);
        return identity.campaignName;
      },
      flags
    );
    const adSetAds = groupAdsRows(
      adsRows,
      (row) => {
        const identity = adsIdentity(row);
        return identity.adSetId || identity.adSetName;
      },
      (row) => {
        const identity = adsIdentity(row);
        return identity.adSetName;
      },
      flags
    );
    const adIdAds = groupAdsRows(
      adsRows,
      (row) => {
        const identity = adsIdentity(row);
        return identity.adId || identity.adNo;
      },
      (row) => {
        const identity = adsIdentity(row);
        return `${identity.adName}${identity.adId ? ` (${identity.adId})` : ""}`;
      },
      flags
    );

    const campaignCommission = new Map();
    const adSetCommission = new Map();
    const adIdCommission = new Map();
    const ambiguousDimensionRows = [];

    function addToCommissionMap(map, key, row) {
      if (!key) return false;
      if (!map.has(key)) map.set(key, groupInit());
      addDimensionCommission(row, map.get(key));
      return true;
    }

    function uniqueSetValue(map, adNo) {
      const set = map.get(adNo);
      return set && set.size === 1 ? [...set][0] : "";
    }

    expectedRows.forEach((row) => {
      const resolved = resolveCommissionAd(row);
      if (!resolved.adNo) return;
      if (resolved.source === "adId") {
        const keys = adIdToKeys.get(resolved.adId);
        if (keys) {
          addToCommissionMap(campaignCommission, keys.campaignKey, row);
          addToCommissionMap(adSetCommission, keys.adSetKey, row);
          addToCommissionMap(adIdCommission, keys.adKey, row);
        }
        return;
      }
      const campaignKey = uniqueSetValue(adNoToCampaignKeys, resolved.adNo);
      const adSetKey = uniqueSetValue(adNoToAdSetKeys, resolved.adNo);
      const adKey = uniqueSetValue(adNoToAdKeys, resolved.adNo);
      const campaignAdded = addToCommissionMap(campaignCommission, campaignKey, row);
      const adSetAdded = addToCommissionMap(adSetCommission, adSetKey, row);
      const adAdded = addToCommissionMap(adIdCommission, adKey, row);
      if (!campaignAdded || !adSetAdded || !adAdded) ambiguousDimensionRows.push(row);
    });

    const adKeys = new Set([...adsByAd.keys(), ...commissionByAd.keys()]);
    const perAd = [...adKeys].map((adNo) => {
      const ads = adsByAd.get(adNo) ? adsMetrics(adsByAd.get(adNo).stats, flags) : adsMetrics(emptyAdsStats(), flags);
      const group = commissionByAd.get(adNo) || groupInit();
      const trafficClicks = ads.trafficClicks;
      const row = {
        adNo,
        spend: ads.spend,
        impressions: ads.impressions,
        reach: ads.reach,
        linkClicks: ads.linkClicks,
        clicksAll: ads.clicksAll,
        outboundClicks: ads.outboundClicks,
        clicksAllAvailable: ads.clicksAllAvailable,
        outboundAvailable: ads.outboundAvailable,
        ctrLink: ads.ctrLink,
        linkClickRate: ads.linkClickRate,
        cpcLink: ads.cpcLink,
        outboundCtr: ads.outboundCtr,
        outboundCpc: ads.outboundCpc,
        linkOutboundGap: ads.linkOutboundGap,
        trafficClicks,
        trafficCtr: ads.trafficCtr,
        trafficCpc: ads.trafficCpc,
        trafficSource: ads.trafficSource,
        cpm: ads.cpm,
        orders: group.orders.size,
        items: group.items,
        purchaseValue: group.purchaseValue,
        expectedCommission: group.expectedCommission,
        completedCommission: group.completedCommission,
        pendingCommission: group.pendingCommission,
        avgCommissionRate: safeDivide(group.expectedCommission, group.purchaseValue),
        commissionRoas: safeDivide(group.expectedCommission, ads.spend),
        gmvRoas: safeDivide(group.purchaseValue, ads.spend),
        roi: safeDivide(group.expectedCommission - ads.spend, ads.spend),
        epc: safeDivide(group.expectedCommission, trafficClicks),
        cpa: safeDivide(ads.spend, group.orders.size),
        orderCvr: safeDivide(group.orders.size, trafficClicks)
      };
      row.action = actionForAd(row, adsTotals.spend);
      return row;
    }).sort((a, b) => {
      if (b.commissionRoas !== a.commissionRoas) return b.commissionRoas - a.commissionRoas;
      return b.expectedCommission - a.expectedCommission;
    });

    const campaignRows = serializeDimensionRows(campaignAds, campaignCommission, adsTotals.spend);
    const adSetRows = serializeDimensionRows(adSetAds, adSetCommission, adsTotals.spend);
    const adIdRows = serializeDimensionRows(adIdAds, adIdCommission, adsTotals.spend);

    const attributionMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "Attribution Type") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const categoryMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "L1 Global Category") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const productMap = groupBy(
      expectedRows,
      (row) => String(getField(row, "Item Name") || "Unknown").trim() || "Unknown",
      (group, row) => addCommissionGroup(group, row, statusType(row))
    );

    const audience = new Map();
    adsRows.forEach((row) => {
      const age = String(getField(row, "Age") || "Unknown").trim() || "Unknown";
      const gender = String(getField(row, "Gender") || "Unknown").trim() || "Unknown";
      const key = `${age} | ${gender}`;
      const current = audience.get(key) || { age, gender, spend: 0, impressions: 0, linkClicks: 0, clicksAll: 0, outboundClicks: 0 };
      current.spend += parseNumber(getField(row, "Amount spent (MYR)"));
      current.impressions += parseNumber(getField(row, "Impressions"));
      current.linkClicks += parseNumber(getField(row, "Link clicks"));
      current.clicksAll += parseNumber(getField(row, "Clicks (all)"));
      current.outboundClicks += parseNumber(getField(row, "Outbound clicks"));
      audience.set(key, current);
    });

    const attribution = [...attributionMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission);

    const categories = [...categoryMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission);

    const products = [...productMap.entries()]
      .map(([key, group]) => serializeGroup(key, group))
      .sort((a, b) => b.expectedCommission - a.expectedCommission)
      .slice(0, 12);

    const audienceRows = [...audience.values()]
      .map((row) => ({
        ...row,
        clicksAllAvailable,
        outboundAvailable,
        ctr: safeDivide(row.linkClicks, row.impressions),
        linkClickRate: clicksAllAvailable ? safeDivide(row.linkClicks, row.clicksAll) : 0,
        cpc: safeDivide(row.spend, row.linkClicks),
        outboundCtr: outboundAvailable ? safeDivide(row.outboundClicks, row.impressions) : 0,
        outboundCpc: outboundAvailable ? safeDivide(row.spend, row.outboundClicks) : 0,
        linkOutboundGap: outboundAvailable ? row.linkClicks - row.outboundClicks : 0,
        trafficClicks: outboundAvailable ? row.outboundClicks : row.linkClicks,
        trafficCtr: outboundAvailable ? safeDivide(row.outboundClicks, row.impressions) : safeDivide(row.linkClicks, row.impressions),
        trafficCpc: outboundAvailable ? safeDivide(row.spend, row.outboundClicks) : safeDivide(row.spend, row.linkClicks),
        trafficSource: outboundAvailable ? "outbound" : "link"
      }))
      .sort((a, b) => b.spend - a.spend);

    const hold = buildHoldAnalysis(expectedRows);

    function buildTrend(mode) {
      const map = new Map();
      function ensure(key) {
        const sortKey = sortPeriodKey(key);
        const current = map.get(key) || { key, label: key, sortKey, adsStats: emptyAdsStats(), group: groupInit() };
        map.set(key, current);
        return current;
      }
      adsRows.forEach((row) => {
        const key = periodKey(adsDateKey(row), mode);
        if (!key) return;
        addAdsStats(ensure(key).adsStats, row);
      });
      expectedRows.forEach((row) => {
        const key = periodKey(orderDateKey(row), mode);
        if (!key) return;
        addCommissionGroup(ensure(key).group, row, statusType(row));
      });
      return [...map.values()]
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .map((item) => {
          const ads = adsMetrics(item.adsStats, flags);
          const group = serializeGroup(item.key, item.group);
          const profit = group.expectedCommission - ads.spend;
          return {
            key: item.key,
            label: item.label,
            sortKey: item.sortKey,
            ...ads,
            orders: group.orders,
            purchaseValue: group.purchaseValue,
            expectedCommission: group.expectedCommission,
            completedCommission: group.completedCommission,
            pendingCommission: group.pendingCommission,
            profit,
            commissionRoas: safeDivide(group.expectedCommission, ads.spend),
            roi: safeDivide(profit, ads.spend),
            epc: safeDivide(group.expectedCommission, ads.trafficClicks),
            epcMinusCpc: safeDivide(group.expectedCommission, ads.trafficClicks) - ads.trafficCpc
          };
        });
    }

    const adsDateKeys = adsRows.map(adsDateKey).filter(Boolean);
    const hasCampaignMetadata = adsRows.some((row) => (
      !isBlank(getField(row, "Campaign name")) ||
      !isBlank(getField(row, "Ad set name")) ||
      !isBlank(getField(row, "Campaign ID")) ||
      !isBlank(getField(row, "Ad set ID")) ||
      !isBlank(getField(row, "Ad ID"))
    ));
    const summaryRows = meta.adsSummaryRows || [];
    const sourceSummaryStats = summaryRows.reduce((stats, item) => {
      addAdsStats(stats, item.row);
      return stats;
    }, emptyAdsStats());
    const dataHealth = {
      adsRowsSelected: meta.adsRowsSelected || adsRows.length,
      adsSummaryRowsIgnored: summaryRows.length,
      adsRowsUsed: adsRows.length,
      commissionRowsUsed: commissionRows.length,
      dateRange: dateRangeText(adsDateKeys),
      dailyBreakdown: new Set(adsDateKeys).size > 1,
      dateCount: new Set(adsDateKeys).size,
      sourceSummaryTotals: adsMetrics(sourceSummaryStats, flags),
      detailTotals: adsTotals,
      ambiguousDimensionCommissionRows: ambiguousDimensionRows.length,
      hasCampaignMetadata
    };

    const expectedCommission = commissionTotals.expectedCommission;
    const purchaseValue = commissionTotals.purchaseValue;
    const trafficClicks = outboundAvailable ? adsTotals.outboundClicks : adsTotals.linkClicks;
    const summary = {
      ads: {
        ...adsTotals
      },
      commission: {
        ...commissionTotals,
        commissionRoas: safeDivide(expectedCommission, adsTotals.spend),
        gmvRoas: safeDivide(purchaseValue, adsTotals.spend),
        roi: safeDivide(expectedCommission - adsTotals.spend, adsTotals.spend),
        breakEvenGmvRoas: expectedCommission > 0 && purchaseValue > 0 ? 1 / safeDivide(expectedCommission, purchaseValue) : 0
      }
    };

    const issues = [];
    if (!adsRows.length) issues.push({ level: "error", title: "Ads CSV missing", detail: "Tiada fail Ads dikesan dalam upload ini." });
    if (!commissionRows.length) issues.push({ level: "error", title: "Commission CSV missing", detail: "Tiada fail Affiliate Commission dikesan dalam upload ini." });
    if (missingClicksAllFiles.length > 0) {
      issues.push({
        level: "warning",
        title: "Clicks (all) missing",
        detail: `${missingClicksAllFiles.join(", ")} tiada column Clicks (all), jadi Total Clicks dan Link/Total % tidak lengkap.`
      });
    }
    if (missingOutboundFiles.length > 0) {
      issues.push({
        level: "warning",
        title: "Outbound clicks missing",
        detail: `${missingOutboundFiles.join(", ")} tiada column Outbound clicks. Dashboard guna Link clicks sebagai fallback traffic KPI.`
      });
    }
    if (dataHealth.adsSummaryRowsIgnored > 0) {
      issues.push({
        level: "info",
        title: "Meta summary row ignored",
        detail: `${dataHealth.adsSummaryRowsIgnored} summary row dibuang supaya spend/click/impression tidak double.`
      });
    }
    if (adsRows.length && !dataHealth.dailyBreakdown) {
      issues.push({
        level: "warning",
        title: "Daily breakdown not detected",
        detail: "Ads CSV nampak summary range, bukan row harian. Trend daily tidak akan direka."
      });
    }
    if (dataHealth.hasCampaignMetadata && dataHealth.ambiguousDimensionCommissionRows > 0) {
      issues.push({
        level: "warning",
        title: "Ambiguous adset/campaign commission",
        detail: `${dataHealth.ambiguousDimensionCommissionRows} commission row tidak dipaksa masuk campaign/adset kerana Sub_id4 lama tidak cukup unik.`
      });
    }
    meta.duplicateAds.forEach((item) => {
      issues.push({ level: "warning", title: "Duplicate Ads CSV ignored", detail: `${item.name} sama seperti ${item.original}.` });
    });
    if (meta.duplicateCommissionDetails.length > 0) {
      const inside = meta.duplicateCommissionDetails.filter((item) => item.scope === "inside");
      const across = meta.duplicateCommissionDetails.filter((item) => item.scope === "across");
      if (inside.length > 0) {
        issues.push({ level: "warning", title: "Duplicate inside uploaded commission file", detail: duplicateDetailText(inside) });
      }
      if (across.length > 0) {
        issues.push({ level: "warning", title: "Duplicate across multiple commission files", detail: duplicateDetailText(across) });
      }
    }
    meta.unknownFiles.forEach((name) => {
      issues.push({ level: "warning", title: "Unknown CSV", detail: `${name} tidak match schema Ads atau Commission.` });
    });
    unmappedRows.forEach((row) => {
      issues.push({
        level: "warning",
        title: "Unmapped Sub_id4",
        detail: `Order ${getField(row, "Order id") || "-"} guna Sub_id4="${getField(row, "Sub_id4")}", tidak boleh map kepada ad number.`
      });
    });
    ["Sub_id2", "Sub_id3", "Channel"].flatMap((field) => buildCasingIssues(expectedRows, field)).forEach((issue) => {
      issues.push({
        level: "warning",
        title: `Casing mismatch ${issue.field}`,
        detail: `${issue.variants.join(" / ")} patut diseragamkan.`
      });
    });
    if (hold.missingTimeRows > 0) {
      issues.push({ level: "warning", title: "Missing hold time", detail: `${hold.missingTimeRows} commission row tiada Click Time atau Order Time.` });
    }
    if (hold.invalidTimeOrders > 0) {
      issues.push({ level: "warning", title: "Invalid hold time", detail: `${hold.invalidTimeOrders} order ada Order Time lebih awal daripada Click Time.` });
    }

    return {
      version: CORE_VERSION,
      createdAt: new Date().toISOString(),
      files: meta.files,
      uploadSummary: buildUploadSummary(meta, adsRows, commissionRows),
      dataHealth,
      summary,
      perAd,
      campaignRows,
      adSetRows,
      adIdRows,
      trend: {
        daily: buildTrend("daily"),
        weekly: buildTrend("weekly"),
        monthly: buildTrend("monthly")
      },
      attribution,
      categories,
      products,
      hold,
      audience: audienceRows,
      issues
    };
  }

  function analyzeUploads(filePayloads) {
    const adsFingerprints = new Map();
    const commissionRecords = new Map();
    const adsRows = [];
    const commissionRows = [];
    const meta = {
      files: [],
      duplicateAds: [],
      duplicateCommissionDetails: [],
      missingClicksAllFiles: [],
      missingOutboundFiles: [],
      adsRowsSelected: 0,
      adsSummaryRows: [],
      unknownFiles: []
    };

    filePayloads.forEach((file, fileIndex) => {
      const parsed = parseCsv(file.text);
      const type = detectFile(parsed);
      meta.files.push({ name: file.name, type, rows: parsed.rows.length });

      if (type === "ads") {
        const fingerprint = fingerprintRows(parsed.headers, parsed.rows);
        if (adsFingerprints.has(fingerprint)) {
          meta.duplicateAds.push({ name: file.name, original: adsFingerprints.get(fingerprint) });
          return;
        }
        adsFingerprints.set(fingerprint, file.name);
        if (!hasColumns(parsed.headers, ["Clicks (all)"])) meta.missingClicksAllFiles.push(file.name);
        if (!hasColumns(parsed.headers, ["Outbound clicks"])) meta.missingOutboundFiles.push(file.name);
        meta.adsRowsSelected += parsed.rows.length;
        parsed.rows.forEach((row, rowIndex) => {
          if (isMetaSummaryRow(row, parsed.headers)) {
            meta.adsSummaryRows.push({ fileName: file.name, rowNumber: rowIndex + 2, row });
            return;
          }
          adsRows.push(row);
        });
        return;
      }

      if (type === "commission") {
        parsed.rows.forEach((row, rowIndex) => {
          const key = commissionKey(row);
          const previous = commissionRecords.get(key);
          if (previous) {
            const scope = previous.fileIndex === fileIndex ? "inside" : "across";
            const originalFile = previous.fileName;
            const originalRow = previous.rowNumber;
            const currentQuality = commissionRowQuality(row);
            const previousQuality = commissionRowQuality(previous.row);
            if (currentQuality > previousQuality) {
              commissionRows[previous.outputIndex] = row;
              previous.row = row;
              previous.fileName = file.name;
              previous.rowNumber = rowIndex + 2;
              previous.fileIndex = fileIndex;
            }
            meta.duplicateCommissionDetails.push({
              scope,
              orderId: duplicateOrderId(row),
              currentFile: file.name,
              currentRow: rowIndex + 2,
              originalFile,
              originalRow
            });
            return;
          }
          commissionRecords.set(key, {
            row,
            fileName: file.name,
            fileIndex,
            rowNumber: rowIndex + 2,
            outputIndex: commissionRows.length
          });
          commissionRows.push(row);
        });
        return;
      }

      meta.unknownFiles.push(file.name);
    });

    return computeAnalysis(adsRows, commissionRows, meta);
  }

  function formatMoney(value) {
    return money.format(Number.isFinite(value) ? value : 0);
  }

  function formatNumber(value) {
    return num.format(Number.isFinite(value) ? value : 0);
  }

  function formatDecimal(value) {
    return decimal.format(Number.isFinite(value) ? value : 0);
  }

  function formatPercent(value) {
    return `${formatDecimal((Number.isFinite(value) ? value : 0) * 100)}%`;
  }

  function formatTotalClicks(row) {
    return row && row.clicksAllAvailable ? formatNumber(row.clicksAll) : "-";
  }

  function formatLinkClickRate(row) {
    return row && row.clicksAllAvailable && row.clicksAll > 0 ? formatPercent(row.linkClickRate) : "-";
  }

  function formatOutboundClicks(row) {
    return row && row.outboundAvailable ? formatNumber(row.outboundClicks) : "-";
  }

  function formatOutboundCtr(row) {
    return row && row.outboundAvailable ? formatPercent(row.outboundCtr) : "-";
  }

  function formatOutboundCpc(row) {
    return row && row.outboundAvailable && row.outboundClicks > 0 ? formatMoney(row.outboundCpc) : "-";
  }

  function formatTrafficCpc(row) {
    return row && row.trafficSource === "outbound" ? formatMoney(row.outboundCpc) : formatMoney(row.cpcLink || row.cpc || row.trafficCpc);
  }

  function formatLinkOutboundGap(row) {
    if (!row || !row.outboundAvailable) return "-";
    const gap = row.linkOutboundGap || 0;
    return `${gap > 0 ? "+" : ""}${formatNumber(gap)}`;
  }

  function duplicateDetailText(details) {
    const orderIds = [...new Set(details.map((item) => item.orderId).filter(Boolean))];
    const shown = orderIds.slice(0, 8).join(", ");
    const more = orderIds.length > 8 ? ` dan ${orderIds.length - 8} lagi` : "";
    const filePairs = [...new Set(details.map((item) => `${item.originalFile} -> ${item.currentFile}`))].slice(0, 3).join("; ");
    return `${details.length} row duplicate dibuang. Order: ${shown || "unknown"}${more}. File: ${filePairs}.`;
  }

  function cloneForSnapshot(value) {
    return JSON.parse(JSON.stringify(value || null));
  }

  function arrayValue(value) {
    return Array.isArray(value) ? value : [];
  }

  function numberValue(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function nestedValue(source, path) {
    return path.split(".").reduce((current, key) => (current && current[key] != null ? current[key] : 0), source);
  }

  function formatByType(value, type) {
    if (type === "money") return formatMoney(value);
    if (type === "percent") return formatPercent(value);
    if (type === "decimal") return formatDecimal(value);
    if (type === "duration") return formatDuration(value);
    return formatNumber(value);
  }

  function deltaClass(delta, direction = "higher") {
    if (!delta) return "muted-text";
    if (direction === "lower") return delta <= 0 ? "profit-text" : "loss-text";
    if (direction === "neutral") return "watch-text";
    return delta >= 0 ? "profit-text" : "loss-text";
  }

  function renderDelta(current, previous, type, direction) {
    const delta = numberValue(current) - numberValue(previous);
    const sign = delta > 0 ? "+" : "";
    return `<span class="delta ${deltaClass(delta, direction)}">${sign}${formatByType(delta, type)}</span>`;
  }

  function actionLabel(action) {
    if (!action) return "-";
    if (typeof action === "string") return action;
    return action.label || "-";
  }

  function buildUploadSummary(meta, adsRows, commissionRows) {
    const adsSelected = meta.files.filter((file) => file.type === "ads").length;
    const commissionSelected = meta.files.filter((file) => file.type === "commission").length;
    const unknownSelected = meta.files.filter((file) => file.type === "unknown").length;
    return {
      adsFilesSelected: adsSelected,
      adsFilesUsed: adsSelected - meta.duplicateAds.length,
      adsRowsSelected: meta.adsRowsSelected || adsRows.length,
      adsSummaryRowsIgnored: (meta.adsSummaryRows || []).length,
      adsRowsUsed: adsRows.length,
      commissionFilesSelected: commissionSelected,
      commissionRowsUsed: commissionRows.length,
      duplicateAdsIgnored: meta.duplicateAds.length,
      duplicateCommissionRowsIgnored: meta.duplicateCommissionDetails.length,
      unknownFiles: unknownSelected
    };
  }

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(safeDivide(ms, 60 * 1000)));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days} hari ${hours} jam`;
    if (hours > 0) return `${hours} jam ${minutes} min`;
    return `${minutes} min`;
  }

  function formatVideoDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}j ${mins}m ${secs}s`;
    }
    return `${minutes}m ${secs}s`;
  }

  function formatBytes(bytes) {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value >= 1024 * 1024 * 1024) return `${formatDecimal(value / (1024 * 1024 * 1024))} GB`;
    if (value >= 1024 * 1024) return `${formatDecimal(value / (1024 * 1024))} MB`;
    if (value >= 1024) return `${formatDecimal(value / 1024)} KB`;
    return `${formatNumber(value)} B`;
  }

  function safeFileExtension(file) {
    const match = String(file && file.name ? file.name : "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1].replace(/[^a-z0-9]/g, "") : "mp4";
  }

  function aspectRatioText(width, height) {
    if (!width || !height) return "-";
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
  }

  function loadScriptOnce(src) {
    if (videoState.ffmpegScript) return videoState.ffmpegScript;
    videoState.ffmpegScript = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-dynamic-src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.dynamicSrc = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Gagal load ${src}`));
      document.head.appendChild(script);
    });
    return videoState.ffmpegScript;
  }

  async function readBlobAsBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function toBlobUrl(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Gagal download ${url}`);
    const blob = new Blob([await response.arrayBuffer()], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  function htmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderTable(container, columns, rows, emptyText) {
    if (!container) return;
    if (!rows.length) {
      container.innerHTML = `<p class="empty-state">${htmlEscape(emptyText || "Tiada data.")}</p>`;
      return;
    }
    const header = columns.map((column) => `<th class="${column.num ? "num" : ""}">${htmlEscape(column.label)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = columns.map((column) => {
        const value = column.render ? column.render(row) : row[column.key];
        return `<td class="${column.num ? "num" : ""}" data-label="${htmlEscape(column.label)}">${value}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    container.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function badge(action) {
    const tone = action && action.tone ? action.tone : "observe";
    const label = action && action.label ? action.label : "Observe";
    return `<span class="badge ${htmlEscape(tone)}">${htmlEscape(label)}</span>`;
  }

  function bar(value, max) {
    const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%"></div></div>`;
  }

  function formatSignedMoney(value) {
    const safe = Number.isFinite(value) ? value : 0;
    return `${safe > 0 ? "+" : ""}${formatMoney(safe)}`;
  }

  function formatSeconds(value) {
    const seconds = Math.round(Number.isFinite(value) ? value : 0);
    return `${seconds}s`;
  }

  function chartPoint(value, min, max, index, count, width, height, pad) {
    const x = count <= 1 ? width / 2 : pad + (index / (count - 1)) * (width - pad * 2);
    const span = max - min || 1;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }

  function renderLineChart(container, rows, series, emptyText) {
    if (!container) return;
    const cleanRows = arrayValue(rows);
    const activeSeries = series.filter((item) => cleanRows.some((row) => Number.isFinite(item.value(row)) && item.value(row) !== 0));
    if (!cleanRows.length || !activeSeries.length) {
      container.innerHTML = `<p class="empty-state">${htmlEscape(emptyText || "Tiada data chart.")}</p>`;
      return;
    }
    const width = 680;
    const height = 260;
    const pad = 34;
    const values = activeSeries.flatMap((item) => cleanRows.map((row) => item.value(row)).filter(Number.isFinite));
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values);
    const lines = activeSeries.map((item) => {
      const points = cleanRows.map((row, index) => chartPoint(item.value(row), min, max, index, cleanRows.length, width, height, pad)).join(" ");
      return `<polyline class="chart-line ${htmlEscape(item.tone || "accent")}" points="${points}"></polyline>`;
    }).join("");
    const labels = cleanRows.map((row, index) => {
      if (index !== 0 && index !== cleanRows.length - 1 && cleanRows.length > 4 && index % Math.ceil(cleanRows.length / 4) !== 0) return "";
      const x = cleanRows.length <= 1 ? width / 2 : pad + (index / (cleanRows.length - 1)) * (width - pad * 2);
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${htmlEscape(row.label)}</text>`;
    }).join("");
    const legend = activeSeries.map((item) => `<span><i class="${htmlEscape(item.tone || "accent")}"></i>${htmlEscape(item.label)}</span>`).join("");
    const last = cleanRows[cleanRows.length - 1];
    const latest = activeSeries.map((item) => `<div><span>${htmlEscape(item.label)}</span><strong>${htmlEscape(item.format(item.value(last)))}</strong></div>`).join("");
    container.innerHTML = `
      <div class="chart-legend">${legend}</div>
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart">
        <line class="chart-grid" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line>
        <text class="chart-axis" x="${pad}" y="18">${htmlEscape(activeSeries[0].format(max))}</text>
        <text class="chart-axis" x="${pad}" y="${height - pad - 6}">${htmlEscape(activeSeries[0].format(min))}</text>
        ${lines}
        ${labels}
      </svg>
      <div class="chart-latest">${latest}</div>
    `;
  }

  function currentTrendMode() {
    const checked = document.querySelector('input[name="trendMode"]:checked');
    return checked ? checked.value : "daily";
  }

  function verdictForAnalysis(analysis) {
    const roas = analysis.summary.commission.commissionRoas;
    const roi = analysis.summary.commission.roi;
    if (roas >= 1) return { tone: "profit", text: `Untung. Commission ROAS ${formatDecimal(roas)} dan ROI ${formatPercent(roi)}.` };
    if (roas >= 0.5) return { tone: "watch", text: `Belum break-even, tapi ada traction. Commission ROAS ${formatDecimal(roas)}.` };
    return { tone: "loss", text: `Rugi. Commission ROAS ${formatDecimal(roas)} dan ROI ${formatPercent(roi)}.` };
  }

  function renderTrend(analysis, mode) {
    const rows = arrayValue(analysis && analysis.trend && analysis.trend[mode]);
    const status = document.getElementById("trendStatus");
    if (!analysis) {
      status.className = "status-panel muted";
      status.querySelector("span").textContent = "Upload dan analisis CSV untuk lihat trend.";
      ["moneyTrendChart", "trafficTrendChart", "roasTrendChart", "clickValueTrendChart", "trendTable"].forEach((id) => {
        document.getElementById(id).innerHTML = "";
      });
      return;
    }
    const health = analysis.dataHealth || {};
    if (mode === "daily" && !health.dailyBreakdown) {
      status.className = "status-panel watch";
      status.querySelector("span").textContent = "Daily breakdown tidak dikesan dalam Ads CSV. Dashboard tidak reka pecahan harian.";
    } else {
      status.className = "status-panel profit";
      status.querySelector("span").textContent = `${rows.length} period dikesan. Ads ikut Reporting starts, commission ikut Order Time.`;
    }
    renderLineChart(document.getElementById("moneyTrendChart"), rows, [
      { label: "Spend", value: (row) => row.spend, format: formatMoney, tone: "red" },
      { label: "Expected Comm", value: (row) => row.expectedCommission, format: formatMoney, tone: "green" },
      { label: "Completed", value: (row) => row.completedCommission, format: formatMoney, tone: "blue" },
      { label: "Profit", value: (row) => row.profit, format: formatSignedMoney, tone: "amber" }
    ], "Tiada trend money.");
    renderLineChart(document.getElementById("trafficTrendChart"), rows, [
      { label: "Outbound", value: (row) => row.outboundClicks, format: formatNumber, tone: "green" },
      { label: "Link", value: (row) => row.linkClicks, format: formatNumber, tone: "blue" }
    ], "Tiada trend traffic.");
    renderLineChart(document.getElementById("roasTrendChart"), rows, [
      { label: "Commission ROAS", value: (row) => row.commissionRoas, format: formatDecimal, tone: "green" }
    ], "Tiada trend ROAS.");
    renderLineChart(document.getElementById("clickValueTrendChart"), rows, [
      { label: "EPC", value: (row) => row.epc, format: formatMoney, tone: "green" },
      { label: "CPC", value: (row) => row.trafficCpc, format: formatMoney, tone: "red" },
      { label: "EPC-CPC", value: (row) => row.epcMinusCpc, format: formatSignedMoney, tone: "amber" }
    ], "Tiada trend click value.");
    renderTable(document.getElementById("trendTable"), [
      { label: "Period", render: (row) => htmlEscape(row.label) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Outbound", num: true, render: (row) => formatOutboundClicks(row) },
      { label: "CPC", num: true, render: (row) => formatTrafficCpc(row) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Profit", num: true, render: (row) => `<span class="${row.profit >= 0 ? "profit-text" : "loss-text"}">${formatSignedMoney(row.profit)}</span>` },
      { label: "ROAS", num: true, render: (row) => formatDecimal(row.commissionRoas) },
      { label: "EPC", num: true, render: (row) => formatMoney(row.epc) },
      { label: "EPC-CPC", num: true, render: (row) => `<span class="${row.epcMinusCpc >= 0 ? "profit-text" : "loss-text"}">${formatSignedMoney(row.epcMinusCpc)}</span>` }
    ], rows, "Tiada trend.");
  }

  function renderPerformanceRows(container, rows, emptyText) {
    renderTable(container, [
      { label: "Name", render: (row) => htmlEscape(row.label || row.key) },
      { label: "Action", render: (row) => badge(row.action) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Impr.", num: true, render: (row) => formatNumber(row.impressions) },
      { label: "Outbound", num: true, render: (row) => formatOutboundClicks(row) },
      { label: "CPC", num: true, render: (row) => formatTrafficCpc(row) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "ROAS", num: true, render: (row) => formatDecimal(row.commissionRoas) },
      { label: "ROI", num: true, render: (row) => `<span class="${row.roi >= 0 ? "profit-text" : "loss-text"}">${formatPercent(row.roi)}</span>` },
      { label: "EPC", num: true, render: (row) => formatMoney(row.epc) }
    ], rows, emptyText);
  }

  function renderCampaignAnalysis(analysis) {
    const note = document.getElementById("campaignNote");
    if (!analysis) {
      note.className = "status-panel muted";
      note.querySelector("span").textContent = "Upload CSV untuk lihat campaign dan ad set.";
      ["campaignTable", "adSetTable", "adIdTable"].forEach((id) => {
        document.getElementById(id).innerHTML = "";
      });
      return;
    }
    const ambiguous = analysis.dataHealth.ambiguousDimensionCommissionRows || 0;
    if (!analysis.dataHealth.hasCampaignMetadata) {
      note.className = "status-panel watch";
      note.querySelector("span").textContent = "Ads CSV lama tiada campaign/adset/ad ID metadata. Upload export baru untuk page ini.";
    } else {
      note.className = `status-panel ${ambiguous ? "watch" : "profit"}`;
      note.querySelector("span").textContent = ambiguous
      ? `${ambiguous} commission row tidak dipaksa masuk campaign/adset kerana Sub_id4 lama tidak cukup unik.`
      : "Campaign/adset commission mapping nampak cukup unik untuk data semasa.";
    }
    renderPerformanceRows(document.getElementById("campaignTable"), analysis.campaignRows, "Tiada campaign data.");
    renderPerformanceRows(document.getElementById("adSetTable"), analysis.adSetRows, "Tiada ad set data.");
    renderPerformanceRows(document.getElementById("adIdTable"), analysis.adIdRows, "Tiada ad ID data.");
  }

  function creativeNote(row) {
    if (row.video25 > 0 && row.videoClickRate < 0.08) return "View ada, click rendah. Check CTA/hook-to-click.";
    if (row.trafficClicks >= 50 && row.expectedCommission <= 0) return "Click ada, komisyen kosong. Check produk/offer.";
    if (row.trafficClicks >= 50 && row.commissionRoas >= 0.4) return "Creative ada traction. Boleh test/protect.";
    return "Observe sampai data cukup.";
  }

  function renderCreativeAnalysis(analysis) {
    const rows = arrayValue(analysis && analysis.adIdRows)
      .filter((row) => row.video25 || row.video50 || row.video75 || row.video100 || row.threeSecondRate)
      .map((row) => ({ ...row, creativeNote: creativeNote(row) }))
      .sort((a, b) => b.trafficClicks - a.trafficClicks);
    const totals = analysis ? analysis.summary.ads : adsMetrics(emptyAdsStats(), { clicksAllAvailable: false, outboundAvailable: false });
    document.getElementById("creativeSummary").innerHTML = [
      ["Video 25%", formatNumber(totals.video25), "Total plays at 25%"],
      ["Video 100%", formatNumber(totals.video100), `Completion ${formatPercent(totals.videoCompletionRate)}`],
      ["Avg Play Time", formatSeconds(totals.videoAvgTime), "Weighted by impressions"],
      ["Click Quality", formatPercent(totals.videoClickRate), "Outbound / 25% plays"]
    ].map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");
    renderTable(document.getElementById("creativeTable"), [
      { label: "Creative", render: (row) => htmlEscape(row.label || row.key) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Outbound", num: true, render: (row) => formatOutboundClicks(row) },
      { label: "25%", num: true, render: (row) => formatNumber(row.video25) },
      { label: "50%", num: true, render: (row) => formatNumber(row.video50) },
      { label: "75%", num: true, render: (row) => formatNumber(row.video75) },
      { label: "100%", num: true, render: (row) => formatNumber(row.video100) },
      { label: "Completion", num: true, render: (row) => formatPercent(row.videoCompletionRate) },
      { label: "Avg Time", num: true, render: (row) => formatSeconds(row.videoAvgTime) },
      { label: "CP Thru", num: true, render: (row) => row.costPerThruPlay ? formatMoney(row.costPerThruPlay) : "-" },
      { label: "ROAS", num: true, render: (row) => formatDecimal(row.commissionRoas) },
      { label: "Note", render: (row) => htmlEscape(row.creativeNote) }
    ], rows, "Tiada video metric dalam Ads CSV.");
  }

  function renderDataHealth(analysis) {
    if (!analysis) {
      document.getElementById("dataHealthGrid").innerHTML = "";
      document.getElementById("dataHealthTable").innerHTML = "";
      document.getElementById("dataHealthIssues").innerHTML = `<p class="empty-state">Belum ada analysis aktif.</p>`;
      return;
    }
    const health = analysis.dataHealth;
    document.getElementById("dataHealthGrid").innerHTML = [
      ["Ads Rows Selected", formatNumber(health.adsRowsSelected), "Row asal dalam CSV Ads"],
      ["Summary Rows Ignored", formatNumber(health.adsSummaryRowsIgnored), "Dibuang untuk elak double count"],
      ["Detail Rows Used", formatNumber(health.adsRowsUsed), "Row sebenar dikira"],
      ["Date Range", health.dateRange, health.dailyBreakdown ? `${health.dateCount} daily periods` : "Daily breakdown not detected"],
      ["Commission Rows", formatNumber(health.commissionRowsUsed), "Rows selepas dedupe"],
      ["Ambiguous Mapping", formatNumber(health.ambiguousDimensionCommissionRows), "Tidak dipaksa masuk adset/campaign"]
    ].map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");
    const source = health.sourceSummaryTotals || {};
    const detail = health.detailTotals || {};
    renderTable(document.getElementById("dataHealthTable"), [
      { label: "Metric", render: (row) => htmlEscape(row.label) },
      { label: "Summary Row", num: true, render: (row) => row.money ? formatMoney(row.source) : formatNumber(row.source) },
      { label: "Detail Rows", num: true, render: (row) => row.money ? formatMoney(row.detail) : formatNumber(row.detail) },
      { label: "Difference", num: true, render: (row) => row.money ? formatMoney(row.detail - row.source) : formatNumber(row.detail - row.source) }
    ], [
      { label: "Spend", source: source.spend || 0, detail: detail.spend || 0, money: true },
      { label: "Impressions", source: source.impressions || 0, detail: detail.impressions || 0 },
      { label: "Clicks all", source: source.clicksAll || 0, detail: detail.clicksAll || 0 },
      { label: "Link clicks", source: source.linkClicks || 0, detail: detail.linkClicks || 0 },
      { label: "Outbound clicks", source: source.outboundClicks || 0, detail: detail.outboundClicks || 0 }
    ], "Tiada reconciliation.");
    renderIssuesInto(document.getElementById("dataHealthIssues"), analysis.issues);
  }

  function renderAnalysis(analysis) {
    const summary = analysis.summary;
    const verdict = verdictForAnalysis(analysis);
    const statusPanel = document.getElementById("statusPanel");
    statusPanel.className = `status-panel ${verdict.tone}`;
    document.getElementById("statusMessage").textContent = verdict.text;

    document.getElementById("kpiSpend").textContent = formatMoney(summary.ads.spend);
    document.getElementById("kpiTraffic").textContent = summary.ads.outboundAvailable
      ? `Outbound ${formatNumber(summary.ads.outboundClicks)} | Link ${formatNumber(summary.ads.linkClicks)} | CPC Out ${formatMoney(summary.ads.outboundCpc)}`
      : `Link clicks fallback ${formatNumber(summary.ads.linkClicks)} | CPC Link ${formatMoney(summary.ads.cpcLink)} | Outbound missing`;
    document.getElementById("kpiExpected").textContent = formatMoney(summary.commission.expectedCommission);
    document.getElementById("kpiCompleted").textContent = `Completed ${formatMoney(summary.commission.completedCommission)}`;
    document.getElementById("kpiRoas").textContent = formatDecimal(summary.commission.commissionRoas);
    document.getElementById("kpiRoi").textContent = `ROI ${formatPercent(summary.commission.roi)}`;
    document.getElementById("kpiBeRoas").textContent = formatDecimal(summary.commission.breakEvenGmvRoas);
    document.getElementById("kpiRate").textContent = `Avg rate ${formatPercent(summary.commission.avgCommissionRate)}`;

    const line = summary.commission.commissionRoas < 1
      ? `Setiap RM1 ads baru balik ${formatMoney(summary.commission.commissionRoas)} komisyen.`
      : "Campaign sudah lepas modal berdasarkan expected commission.";
    document.getElementById("summaryLine").textContent = line;
    renderUploadSummary(analysis.uploadSummary);

    const metrics = [
      ["Impressions", formatNumber(summary.ads.impressions), `Reach ${formatNumber(summary.ads.reach)}`],
      ["Outbound Clicks", formatOutboundClicks(summary.ads), summary.ads.outboundAvailable ? `Link Clicks ${formatNumber(summary.ads.linkClicks)}` : "Missing, guna link fallback"],
      ["Outbound CTR", formatOutboundCtr(summary.ads), `CTR Link ${formatPercent(summary.ads.ctrLink)}`],
      ["Outbound CPC", formatOutboundCpc(summary.ads), `CPC Link ${formatMoney(summary.ads.cpcLink)}`],
      ["Link vs Outbound Gap", formatLinkOutboundGap(summary.ads), "Link clicks - outbound clicks"],
      ["CTR Link", formatPercent(summary.ads.ctrLink), `CPM ${formatMoney(summary.ads.cpm)}`],
      ["Total Clicks", formatTotalClicks(summary.ads), `Link Clicks ${formatNumber(summary.ads.linkClicks)}`],
      ["Link / Total Click", formatLinkClickRate(summary.ads), "Kualiti klik ke Shopee"],
      ["Orders Expected", formatNumber(summary.commission.orders), `${summary.commission.items} item rows`],
      ["Purchase Value", formatMoney(summary.commission.purchaseValue), `GMV ROAS ${formatDecimal(summary.commission.gmvRoas)}`],
      ["Pending Commission", formatMoney(summary.commission.pendingCommission), "Belum confirmed"],
      ["Completed Commission", formatMoney(summary.commission.completedCommission), "Confirmed risk check"],
      ["Avg Hold Time", formatDuration(analysis.hold.avgMs), `${formatPercent(analysis.hold.sameDayRate)} same-day`],
      ["Delayed Orders", formatPercent(analysis.hold.delayedRate), ">24 jam selepas click"],
      ["Break-even GMV", formatMoney(summary.ads.spend / Math.max(summary.commission.avgCommissionRate, 0.000001)), `Need ROAS ${formatDecimal(summary.commission.breakEvenGmvRoas)}`],
      ["Cancelled", formatNumber(summary.commission.cancelledOrders), `${summary.commission.cancelledItems} item rows`]
    ];

    document.getElementById("summaryGrid").innerHTML = metrics.map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");

    const maxAdRoas = Math.max(...analysis.perAd.map((row) => row.commissionRoas), 1);
    renderTable(document.getElementById("adTable"), [
      { label: "Ad", render: (row) => htmlEscape(row.adNo) },
      { label: "Action", render: (row) => badge(row.action) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Outbound Clicks", num: true, render: (row) => formatOutboundClicks(row) },
      { label: "Outbound CPC", num: true, render: (row) => formatOutboundCpc(row) },
      { label: "Outbound CTR", num: true, render: (row) => formatOutboundCtr(row) },
      { label: "Link Clicks", num: true, render: (row) => formatNumber(row.linkClicks) },
      { label: "Gap", num: true, render: (row) => formatLinkOutboundGap(row) },
      { label: "EPC", num: true, render: (row) => formatMoney(row.epc) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "ROAS", num: true, render: (row) => formatDecimal(row.commissionRoas) },
      { label: "ROI", num: true, render: (row) => `<span class="${row.roi >= 0 ? "profit-text" : "loss-text"}">${formatPercent(row.roi)}</span>` },
      { label: "Signal", render: (row) => `<div class="bar-cell">${bar(row.commissionRoas, maxAdRoas)}</div>` },
      { label: "Note", render: (row) => htmlEscape(row.action.note) }
    ], analysis.perAd, "Tiada data ad.");

    const maxAttr = Math.max(...analysis.attribution.map((row) => row.expectedCommission), 1);
    renderTable(document.getElementById("attributionTable"), [
      { label: "Type", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Rate", num: true, render: (row) => formatPercent(row.avgCommissionRate) },
      { label: "Bar", render: (row) => bar(row.expectedCommission, maxAttr) }
    ], analysis.attribution, "Tiada data attribution.");

    const maxCategory = Math.max(...analysis.categories.map((row) => row.expectedCommission), 1);
    renderTable(document.getElementById("categoryTable"), [
      { label: "Category", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Rate", num: true, render: (row) => formatPercent(row.avgCommissionRate) },
      { label: "Bar", render: (row) => bar(row.expectedCommission, maxCategory) }
    ], analysis.categories, "Tiada data category.");

    const maxHoldOrders = Math.max(...analysis.hold.buckets.map((row) => row.orders), 1);
    document.getElementById("holdSummary").innerHTML = [
      ["Orders With Time", formatNumber(analysis.hold.totalOrders), "Click Time -> Order Time"],
      ["Average Hold", formatDuration(analysis.hold.avgMs), `Median ${formatDuration(analysis.hold.medianMs)}`],
      ["Same-hour Rate", formatPercent(analysis.hold.sameHourRate), "Order dalam 1 jam"],
      ["Same-day Rate", formatPercent(analysis.hold.sameDayRate), "Order dalam 24 jam"],
      ["Delayed Rate", formatPercent(analysis.hold.delayedRate), "Order selepas 24 jam"],
      ["Longest Hold", formatDuration(analysis.hold.longestMs), "Cookie delay paling lama"]
    ].map(([label, value, note]) => (
      `<article class="metric-card"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></article>`
    )).join("");

    renderTable(document.getElementById("holdTable"), [
      { label: "Hold Bucket", render: (row) => htmlEscape(row.key) },
      { label: "Orders", num: true, render: (row) => formatNumber(row.orders) },
      { label: "Hold Rate", num: true, render: (row) => formatPercent(row.rate) },
      { label: "PV", num: true, render: (row) => formatMoney(row.purchaseValue) },
      { label: "Comm", num: true, render: (row) => formatMoney(row.expectedCommission) },
      { label: "Comm Share", num: true, render: (row) => formatPercent(row.commissionShare) },
      { label: "Signal", render: (row) => `<div class="bar-cell">${bar(row.orders, maxHoldOrders)}</div>` }
    ], analysis.hold.buckets, "Tiada data hold rate.");

    renderTable(document.getElementById("audienceTable"), [
      { label: "Age", render: (row) => htmlEscape(row.age) },
      { label: "Gender", render: (row) => htmlEscape(row.gender) },
      { label: "Spend", num: true, render: (row) => formatMoney(row.spend) },
      { label: "Impr.", num: true, render: (row) => formatNumber(row.impressions) },
      { label: "Outbound Clicks", num: true, render: (row) => formatOutboundClicks(row) },
      { label: "Outbound CTR", num: true, render: (row) => formatOutboundCtr(row) },
      { label: "Outbound CPC", num: true, render: (row) => formatOutboundCpc(row) },
      { label: "Link Clicks", num: true, render: (row) => formatNumber(row.linkClicks) },
      { label: "Gap", num: true, render: (row) => formatLinkOutboundGap(row) },
      { label: "Total Clicks", num: true, render: (row) => formatTotalClicks(row) },
      { label: "Link/Total %", num: true, render: (row) => formatLinkClickRate(row) },
      { label: "Link CTR", num: true, render: (row) => formatPercent(row.ctr) },
      { label: "Link CPC", num: true, render: (row) => formatMoney(row.cpc) }
    ], analysis.audience, "Tiada data audience.");

    renderIssues(analysis.issues);
    renderTrend(analysis, currentTrendMode());
    renderCampaignAnalysis(analysis);
    renderCreativeAnalysis(analysis);
    renderDataHealth(analysis);
    renderSnapshots(analysis);
    document.getElementById("saveSnapshotBtn").disabled = false;
  }

  function renderIssues(issues) {
    renderIssuesInto(document.getElementById("issuesList"), issues);
  }

  function renderIssuesInto(container, issues) {
    if (!container) return;
    const rows = arrayValue(issues);
    if (!rows.length) {
      container.innerHTML = `<p class="empty-state">Tiada isu tracking dikesan.</p>`;
      return;
    }
    container.innerHTML = rows.map((issue) => (
      `<div class="issue-item ${htmlEscape(issue.level)}"><strong>${htmlEscape(issue.title)}</strong><span>${htmlEscape(issue.detail)}</span></div>`
    )).join("");
  }

  function renderUploadSummary(summary) {
    const container = document.getElementById("uploadSummary");
    if (!container) return;
    if (!summary) {
      container.className = "upload-summary";
      container.innerHTML = "";
      return;
    }
    container.className = "upload-summary active";
    const stats = [
      ["Ads Files Used", `${summary.adsFilesUsed}/${summary.adsFilesSelected}`, `${summary.adsRowsUsed}/${summary.adsRowsSelected} detail rows`],
      ["Meta Summary Ignored", `${summary.adsSummaryRowsIgnored}`, "Prevent double count"],
      ["Commission Files", `${summary.commissionFilesSelected}`, `${summary.commissionRowsUsed} rows used`],
      ["Duplicate Ignored", `${summary.duplicateAdsIgnored + summary.duplicateCommissionRowsIgnored}`, `${summary.duplicateCommissionRowsIgnored} commission rows`],
      ["Unknown Files", `${summary.unknownFiles}`, "Rejected CSV"]
    ];
    container.innerHTML = stats.map(([label, value, note]) => (
      `<div class="upload-stat"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></div>`
    )).join("");
  }

  function clearCurrentAnalysisUi() {
    document.getElementById("statusPanel").className = "status-panel muted";
    document.getElementById("statusMessage").textContent = "Belum ada data dianalisis.";
    document.getElementById("saveSnapshotBtn").disabled = true;
    ["kpiSpend", "kpiTraffic", "kpiExpected", "kpiCompleted", "kpiRoas", "kpiRoi", "kpiBeRoas", "kpiRate"].forEach((id) => {
      document.getElementById(id).textContent = "-";
    });
    document.getElementById("summaryLine").textContent = "Upload CSV untuk mula.";
    document.getElementById("summaryGrid").innerHTML = "";
    document.getElementById("adTable").innerHTML = "";
    document.getElementById("attributionTable").innerHTML = "";
    document.getElementById("categoryTable").innerHTML = "";
    document.getElementById("holdSummary").innerHTML = "";
    document.getElementById("holdTable").innerHTML = "";
    document.getElementById("audienceTable").innerHTML = "";
    document.getElementById("issuesList").innerHTML = `<p class="empty-state">Belum ada analysis aktif.</p>`;
    renderTrend(null, "daily");
    renderCampaignAnalysis(null);
    renderCreativeAnalysis(null);
    renderDataHealth(null);
    document.getElementById("snapshotComparePanel").innerHTML = "";
    document.getElementById("snapshotName").value = "";
    document.getElementById("snapshotCompare").value = "";
    renderUploadSummary(null);
  }

  function loadSnapshots() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (_error) {
      return [];
    }
  }

  function saveSnapshots(snapshots) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots.slice(0, 30)));
  }

  function snapshotFromAnalysis(analysis, name) {
    return {
      id: `${Date.now()}`,
      name: name || `Snapshot ${new Date().toLocaleString("ms-MY")}`,
      createdAt: new Date().toISOString(),
      appVersion: CORE_VERSION,
      files: cloneForSnapshot(analysis.files),
      uploadSummary: cloneForSnapshot(analysis.uploadSummary),
      dataHealth: cloneForSnapshot(analysis.dataHealth),
      summary: cloneForSnapshot(analysis.summary),
      perAd: cloneForSnapshot(analysis.perAd),
      campaignRows: cloneForSnapshot(analysis.campaignRows),
      adSetRows: cloneForSnapshot(analysis.adSetRows),
      adIdRows: cloneForSnapshot(analysis.adIdRows),
      trend: cloneForSnapshot(analysis.trend),
      attribution: cloneForSnapshot(analysis.attribution),
      categories: cloneForSnapshot(analysis.categories),
      products: cloneForSnapshot(analysis.products),
      hold: cloneForSnapshot(analysis.hold),
      audience: cloneForSnapshot(analysis.audience),
      issues: cloneForSnapshot(analysis.issues)
    };
  }

  function renderSnapshots(currentAnalysis) {
    const snapshots = loadSnapshots();
    const list = document.getElementById("snapshotList");
    const compare = document.getElementById("snapshotCompare");
    compare.innerHTML = `<option value="">Pilih snapshot untuk compare</option>${snapshots.map((snapshot) => (
      `<option value="${htmlEscape(snapshot.id)}">${htmlEscape(snapshot.name)}</option>`
    )).join("")}`;

    if (!snapshots.length) {
      list.innerHTML = `<p class="empty-state">Belum ada snapshot.</p>`;
      document.getElementById("snapshotComparePanel").innerHTML = "";
      return;
    }

    list.innerHTML = snapshots.map((snapshot) => (
      `<div class="snapshot-item">
        <div>
          <strong>${htmlEscape(snapshot.name)}</strong>
          <div class="snapshot-meta">${new Date(snapshot.createdAt).toLocaleString("ms-MY")} | Spend ${formatMoney(snapshot.summary.ads.spend)} | Comm ${formatMoney(snapshot.summary.commission.expectedCommission)}</div>
        </div>
        <button class="btn danger" type="button" data-delete-snapshot="${htmlEscape(snapshot.id)}">Delete</button>
      </div>`
    )).join("");

    list.querySelectorAll("[data-delete-snapshot]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = loadSnapshots().filter((snapshot) => snapshot.id !== button.dataset.deleteSnapshot);
        saveSnapshots(next);
        renderSnapshots(currentAnalysis);
      });
    });
  }

  function renderCompareMetric(label, current, previous, type, direction) {
    return `
      <div class="compare-metric">
        <span>${htmlEscape(label)}</span>
        <strong>${formatByType(current, type)}</strong>
        <small>Snapshot ${formatByType(previous, type)} ${renderDelta(current, previous, type, direction)}</small>
      </div>`;
  }

  function renderKpiCompare(currentAnalysis, snapshot) {
    const current = currentAnalysis.summary || {};
    const previous = snapshot.summary || {};
    const metrics = [
      ["Spend", "ads.spend", "money", "neutral"],
      ["Outbound Clicks", "ads.outboundClicks", "number", "higher"],
      ["Outbound CTR", "ads.outboundCtr", "percent", "higher"],
      ["Outbound CPC", "ads.outboundCpc", "money", "lower"],
      ["Link vs Outbound Gap", "ads.linkOutboundGap", "number", "lower"],
      ["Link Clicks", "ads.linkClicks", "number", "higher"],
      ["Total Clicks", "ads.clicksAll", "number", "higher"],
      ["Link/Total %", "ads.linkClickRate", "percent", "higher"],
      ["Expected Comm", "commission.expectedCommission", "money", "higher"],
      ["Completed Comm", "commission.completedCommission", "money", "higher"],
      ["Orders", "commission.orders", "number", "higher"],
      ["Commission ROAS", "commission.commissionRoas", "decimal", "higher"],
      ["ROI", "commission.roi", "percent", "higher"],
      ["Avg Comm Rate", "commission.avgCommissionRate", "percent", "higher"],
      ["Purchase Value", "commission.purchaseValue", "money", "higher"],
      ["BE GMV ROAS", "commission.breakEvenGmvRoas", "decimal", "lower"],
      ["Same-day Hold", "hold.sameDayRate", "percent", "higher"],
      ["Delayed Orders", "hold.delayedRate", "percent", "lower"]
    ];

    const cards = metrics.map(([label, path, type, direction]) => {
      const currentSource = path.startsWith("hold.") ? currentAnalysis : current;
      const previousSource = path.startsWith("hold.") ? snapshot : previous;
      const cleanPath = path.startsWith("hold.") ? path : path;
      return renderCompareMetric(label, nestedValue(currentSource, cleanPath), nestedValue(previousSource, cleanPath), type, direction);
    }).join("");

    return `<section class="compare-block"><h3>KPI Summary</h3><div class="compare-metrics">${cards}</div></section>`;
  }

  function renderUploadCompare(currentAnalysis, snapshot) {
    const current = currentAnalysis.uploadSummary || {};
    const previous = snapshot.uploadSummary || {};
    const rows = [
      ["Ads files used", `${numberValue(current.adsFilesUsed)}/${numberValue(current.adsFilesSelected)}`, `${numberValue(previous.adsFilesUsed)}/${numberValue(previous.adsFilesSelected)}`],
      ["Ads rows used", formatNumber(numberValue(current.adsRowsUsed)), formatNumber(numberValue(previous.adsRowsUsed))],
      ["Commission files", formatNumber(numberValue(current.commissionFilesSelected)), formatNumber(numberValue(previous.commissionFilesSelected))],
      ["Commission rows used", formatNumber(numberValue(current.commissionRowsUsed)), formatNumber(numberValue(previous.commissionRowsUsed))],
      ["Duplicate rows ignored", formatNumber(numberValue(current.duplicateAdsIgnored) + numberValue(current.duplicateCommissionRowsIgnored)), formatNumber(numberValue(previous.duplicateAdsIgnored) + numberValue(previous.duplicateCommissionRowsIgnored))],
      ["Unknown files", formatNumber(numberValue(current.unknownFiles)), formatNumber(numberValue(previous.unknownFiles))]
    ];

    return `
      <section class="compare-block">
        <h3>Upload Summary</h3>
        <div class="compare-list">
          ${rows.map(([label, currentText, previousText]) => (
            `<div><span>${htmlEscape(label)}</span><strong>${htmlEscape(currentText)}</strong><small>Snapshot ${htmlEscape(previousText)}</small></div>`
          )).join("")}
        </div>
      </section>`;
  }

  function rowKey(row, keyName) {
    return String(row && row[keyName] != null ? row[keyName] : "").trim();
  }

  function compareKeys(currentRows, previousRows, keyFn) {
    const keys = [];
    const seen = new Set();
    currentRows.forEach((row) => {
      const key = keyFn(row);
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
    previousRows.forEach((row) => {
      const key = keyFn(row);
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
    return keys;
  }

  function renderCompareCell(currentRow, previousRow, column) {
    if (column.render) return column.render(currentRow, previousRow);
    const current = nestedValue(currentRow || {}, column.path);
    const previous = nestedValue(previousRow || {}, column.path);
    return `<div class="compare-cell"><strong>${formatByType(current, column.type)}</strong>${renderDelta(current, previous, column.type, column.direction)}</div>`;
  }

  function renderDimensionCompare(title, currentRows, previousRows, keyFn, columns, emptyText) {
    const current = arrayValue(currentRows);
    const previous = arrayValue(previousRows);
    if (!current.length && !previous.length) {
      return `<section class="compare-block"><h3>${htmlEscape(title)}</h3><p class="empty-state">${htmlEscape(emptyText || "Tiada data untuk compare.")}</p></section>`;
    }

    const currentMap = new Map(current.map((row) => [keyFn(row), row]));
    const previousMap = new Map(previous.map((row) => [keyFn(row), row]));
    const keys = compareKeys(current, previous, keyFn);
    const header = columns.map((column) => `<th class="${column.num ? "num" : ""}">${htmlEscape(column.label)}</th>`).join("");
    const body = keys.map((key) => {
      const currentRow = currentMap.get(key);
      const previousRow = previousMap.get(key);
      const status = currentRow && previousRow ? "" : currentRow ? "Baru" : "Hilang";
      const statusBadge = status ? `<span class="compare-status">${htmlEscape(status)}</span>` : "";
      const cells = columns.map((column) => (
        `<td class="${column.num ? "num" : ""}" data-label="${htmlEscape(column.label)}">${renderCompareCell(currentRow, previousRow, column)}</td>`
      )).join("");
      return `<tr><td data-label="Key"><strong>${htmlEscape(key)}</strong>${statusBadge}</td>${cells}</tr>`;
    }).join("");
    const note = !previous.length && current.length ? `<p class="compare-note">Snapshot lama mungkin belum simpan data section ini.</p>` : "";

    return `
      <section class="compare-block">
        <h3>${htmlEscape(title)}</h3>
        ${note}
        <div class="table-wrap compare-table">
          <table><thead><tr><th>Key</th>${header}</tr></thead><tbody>${body}</tbody></table>
        </div>
      </section>`;
  }

  function renderAdCompare(currentAnalysis, snapshot) {
    return renderDimensionCompare(
      "Ad / Sub_id4 Ranking",
      arrayValue(currentAnalysis.perAd),
      arrayValue(snapshot.perAd),
      (row) => rowKey(row, "adNo"),
      [
        {
          label: "Action",
          render: (currentRow, previousRow) => `<div class="compare-cell"><strong>${htmlEscape(actionLabel(currentRow && currentRow.action))}</strong><small>Snapshot ${htmlEscape(actionLabel(previousRow && previousRow.action))}</small></div>`
        },
        { label: "Spend", path: "spend", type: "money", direction: "neutral", num: true },
        { label: "Outbound Clicks", path: "outboundClicks", type: "number", direction: "higher", num: true },
        { label: "Outbound CPC", path: "outboundCpc", type: "money", direction: "lower", num: true },
        { label: "Outbound CTR", path: "outboundCtr", type: "percent", direction: "higher", num: true },
        { label: "Link Clicks", path: "linkClicks", type: "number", direction: "higher", num: true },
        { label: "Gap", path: "linkOutboundGap", type: "number", direction: "lower", num: true },
        { label: "Total Clicks", path: "clicksAll", type: "number", direction: "higher", num: true },
        { label: "Link/Total %", path: "linkClickRate", type: "percent", direction: "higher", num: true },
        { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
        { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
        { label: "ROAS", path: "commissionRoas", type: "decimal", direction: "higher", num: true },
        { label: "ROI", path: "roi", type: "percent", direction: "higher", num: true }
      ],
      "Tiada data ad."
    );
  }

  function renderGroupCompare(title, currentRows, previousRows, keyName) {
    return renderDimensionCompare(
      title,
      currentRows,
      previousRows,
      (row) => rowKey(row, keyName),
      [
        { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
        { label: "Items", path: "items", type: "number", direction: "higher", num: true },
        { label: "PV", path: "purchaseValue", type: "money", direction: "higher", num: true },
        { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
        { label: "Rate", path: "avgCommissionRate", type: "percent", direction: "higher", num: true }
      ],
      `Tiada data ${title.toLowerCase()}.`
    );
  }

  function renderHoldCompare(currentAnalysis, snapshot) {
    const currentHold = currentAnalysis.hold || {};
    const previousHold = snapshot.hold || {};
    const metrics = [
      ["Orders With Time", "totalOrders", "number", "higher"],
      ["Average Hold", "avgMs", "duration", "lower"],
      ["Median Hold", "medianMs", "duration", "lower"],
      ["Same-hour Rate", "sameHourRate", "percent", "higher"],
      ["Same-day Rate", "sameDayRate", "percent", "higher"],
      ["Delayed Rate", "delayedRate", "percent", "lower"],
      ["Longest Hold", "longestMs", "duration", "lower"],
      ["Hold Comm", "totalCommission", "money", "higher"]
    ];
    const metricCards = metrics.map(([label, path, type, direction]) => (
      renderCompareMetric(label, nestedValue(currentHold, path), nestedValue(previousHold, path), type, direction)
    )).join("");

    return `
      <section class="compare-block">
        <h3>Hold Rate / Cookie Delay</h3>
        <div class="compare-metrics">${metricCards}</div>
        ${renderDimensionCompare(
          "Hold Buckets",
          arrayValue(currentHold.buckets),
          arrayValue(previousHold.buckets),
          (row) => rowKey(row, "key"),
          [
            { label: "Orders", path: "orders", type: "number", direction: "higher", num: true },
            { label: "Hold Rate", path: "rate", type: "percent", direction: "higher", num: true },
            { label: "PV", path: "purchaseValue", type: "money", direction: "higher", num: true },
            { label: "Comm", path: "expectedCommission", type: "money", direction: "higher", num: true },
            { label: "Comm Share", path: "commissionShare", type: "percent", direction: "higher", num: true }
          ],
          "Tiada data hold bucket."
        )}
      </section>`;
  }

  function renderAudienceCompare(currentAnalysis, snapshot) {
    return renderDimensionCompare(
      "Audience",
      arrayValue(currentAnalysis.audience),
      arrayValue(snapshot.audience),
      (row) => `${rowKey(row, "age")} | ${rowKey(row, "gender")}`,
      [
        { label: "Spend", path: "spend", type: "money", direction: "neutral", num: true },
        { label: "Impr.", path: "impressions", type: "number", direction: "higher", num: true },
        { label: "Outbound Clicks", path: "outboundClicks", type: "number", direction: "higher", num: true },
        { label: "Outbound CTR", path: "outboundCtr", type: "percent", direction: "higher", num: true },
        { label: "Outbound CPC", path: "outboundCpc", type: "money", direction: "lower", num: true },
        { label: "Link Clicks", path: "linkClicks", type: "number", direction: "higher", num: true },
        { label: "Gap", path: "linkOutboundGap", type: "number", direction: "lower", num: true },
        { label: "Total Clicks", path: "clicksAll", type: "number", direction: "higher", num: true },
        { label: "Link/Total %", path: "linkClickRate", type: "percent", direction: "higher", num: true },
        { label: "Link CTR", path: "ctr", type: "percent", direction: "higher", num: true },
        { label: "Link CPC", path: "cpc", type: "money", direction: "lower", num: true }
      ],
      "Tiada data audience."
    );
  }

  function renderIssueListForCompare(issues) {
    const rows = arrayValue(issues);
    if (!rows.length) return `<p class="empty-state">Tiada isu.</p>`;
    return rows.map((issue) => (
      `<div class="compare-issue"><strong>${htmlEscape(issue.title || "-")}</strong><span>${htmlEscape(issue.detail || "")}</span></div>`
    )).join("");
  }

  function renderIssueCompare(currentAnalysis, snapshot) {
    const currentIssues = arrayValue(currentAnalysis.issues);
    const previousIssues = arrayValue(snapshot.issues);
    return `
      <section class="compare-block">
        <h3>Tracking Issues</h3>
        <div class="compare-issue-grid">
          <div>
            <h4>Current (${formatNumber(currentIssues.length)})</h4>
            ${renderIssueListForCompare(currentIssues)}
          </div>
          <div>
            <h4>Snapshot (${formatNumber(previousIssues.length)})</h4>
            ${renderIssueListForCompare(previousIssues)}
          </div>
        </div>
      </section>`;
  }

  function renderCompare(currentAnalysis, snapshotId) {
    const panel = document.getElementById("snapshotComparePanel");
    if (!snapshotId) {
      panel.innerHTML = "";
      return;
    }
    const snapshot = loadSnapshots().find((item) => item.id === snapshotId);
    if (!snapshot) {
      panel.innerHTML = "";
      return;
    }
    if (!currentAnalysis) {
      panel.innerHTML = `<div class="compare-card"><strong>Compare vs ${htmlEscape(snapshot.name)}</strong><p class="empty-state">Upload dan tekan Analisis dahulu untuk compare dengan snapshot ini.</p></div>`;
      return;
    }

    panel.innerHTML = `
      <div class="compare-card">
        <strong>Compare current analysis vs ${htmlEscape(snapshot.name)}</strong>
        ${renderKpiCompare(currentAnalysis, snapshot)}
        ${renderUploadCompare(currentAnalysis, snapshot)}
        ${renderAdCompare(currentAnalysis, snapshot)}
        ${renderGroupCompare("Attribution", arrayValue(currentAnalysis.attribution), arrayValue(snapshot.attribution), "key")}
        ${renderGroupCompare("Category", arrayValue(currentAnalysis.categories), arrayValue(snapshot.categories), "key")}
        ${renderGroupCompare("Product", arrayValue(currentAnalysis.products), arrayValue(snapshot.products), "key")}
        ${renderHoldCompare(currentAnalysis, snapshot)}
        ${renderAudienceCompare(currentAnalysis, snapshot)}
        ${renderIssueCompare(currentAnalysis, snapshot)}
      </div>`;
  }

  async function readFiles(files) {
    const payloads = [];
    for (const file of files) {
      const text = await file.text();
      payloads.push({ name: file.name, size: file.size, text });
    }
    return payloads;
  }

  function updateFileList(files) {
    const list = document.getElementById("fileList");
    if (!files.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = [...files].map((file) => `<span class="file-pill">${htmlEscape(file.name)}</span>`).join("");
  }

  function setActivePage(page) {
    const pages = {
      overview: { title: "Overview Dashboard", eyebrow: "Shopee Affiliate Cookies" },
      trend: { title: "Trend Analytics", eyebrow: "Daily Weekly Monthly" },
      campaign: { title: "Campaign & Ad Set", eyebrow: "Meta Ads Breakdown" },
      creative: { title: "Creative Video", eyebrow: "Video Performance" },
      health: { title: "Data Health", eyebrow: "Accuracy Check" },
      video: { title: "Video Converter", eyebrow: "Browser Video Tool" }
    };
    const target = pages[page] ? page : "overview";
    const isVideo = target === "video";
    document.body.dataset.page = target;
    Object.keys(pages).forEach((key) => {
      const el = document.getElementById(`${key}Page`);
      if (el) el.hidden = key !== target;
    });
    document.getElementById("performanceActions").hidden = isVideo;
    document.getElementById("appTitle").textContent = pages[target].title;
    document.getElementById("pageEyebrow").textContent = pages[target].eyebrow;
    document.querySelectorAll("[data-page-target]").forEach((button) => {
      button.classList.toggle("active", button.dataset.pageTarget === target);
    });
    closeMobileSidebar();
  }

  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    const toggle = document.getElementById("sidebarToggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.textContent = collapsed ? "Open" : "Hide";
    }
  }

  function openMobileSidebar() {
    document.body.classList.add("sidebar-opened");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (backdrop) backdrop.hidden = false;
  }

  function closeMobileSidebar() {
    document.body.classList.remove("sidebar-opened");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  function setVideoStatus(tone, message) {
    const panel = document.getElementById("videoStatus");
    panel.className = `status-panel ${tone || "muted"}`;
    panel.querySelector("span").textContent = message;
  }

  function setVideoProgress(value, message) {
    const percent = Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 0) * 100)));
    document.getElementById("videoProgressFill").style.width = `${percent}%`;
    document.getElementById("videoProgressText").textContent = `${percent}%`;
    if (message) setVideoStatus("watch", message);
  }

  function appendVideoLog(message) {
    const log = document.getElementById("videoLog");
    const clean = String(message || "").trim();
    if (!clean) return;
    if (clean === "Aborted()") return;
    const current = log.textContent === "Belum ada proses." ? "" : log.textContent;
    log.textContent = `${current}${current ? "\n" : ""}${clean}`.split("\n").slice(-60).join("\n");
    log.scrollTop = log.scrollHeight;
  }

  function emptyVideoMetadata() {
    return { duration: 0, width: 0, height: 0 };
  }

  function videoItemId(index) {
    return `video-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
  }

  function cleanOutputBaseName(name) {
    return String(name || "video")
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .trim() || "video";
  }

  function looksLikeVideoFile(file) {
    return (file.type && file.type.startsWith("video/")) || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name || "");
  }

  function outputFileName(item, targetHeight) {
    return `${cleanOutputBaseName(item.name)}-shopee-${targetHeight}p.mp4`;
  }

  function selectedVideoItem() {
    return videoState.queue.find((item) => item.id === videoState.selectedId) || videoState.queue[0] || null;
  }

  function clearVideoItemOutput(item) {
    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    item.outputUrl = "";
    item.outputSize = 0;
    item.outputMetadata = emptyVideoMetadata();
    item.safe = null;
    item.elapsedSeconds = 0;
    item.error = "";
  }

  function clearQueueOutputs() {
    videoState.queue.forEach((item) => {
      clearVideoItemOutput(item);
      item.status = "pending";
      item.targetHeight = "";
      item.preset = "";
    });
    document.getElementById("videoOutputSummary").className = "upload-summary";
    document.getElementById("videoOutputSummary").innerHTML = "";
  }

  async function deleteVirtualVideoFiles(names) {
    if (!videoState.ffmpeg) return;
    const fileNames = (names || [videoState.inputName, videoState.outputName]).filter(Boolean);
    for (const name of fileNames) {
      try {
        await videoState.ffmpeg.deleteFile(name);
      } catch (_error) {
        // File may already be gone after a reset or failed conversion.
      }
    }
    videoState.inputName = "";
    videoState.outputName = "";
  }

  function videoOrientation(width, height) {
    if (!width || !height) return "vertical";
    if (height > width) return "vertical";
    if (width > height) return "landscape";
    return "square";
  }

  function videoFilterForTarget(targetHeight, metadata) {
    const target = Number.parseInt(targetHeight, 10) || 720;
    const source = metadata || emptyVideoMetadata();
    const orientation = videoOrientation(source.width, source.height);
    const longSide = Math.round(target * 16 / 9);
    const currentWidth = source.width || 0;
    const currentHeight = source.height || 0;
    const fpsCap = "fps=30";

    if (orientation === "vertical") {
      if (currentWidth === target && currentHeight === longSide) return `${fpsCap},setsar=1`;
      return `${fpsCap},scale=${target}:${longSide}:force_original_aspect_ratio=increase:flags=lanczos,crop=${target}:${longSide},setsar=1`;
    }
    if (orientation === "landscape") {
      if (currentWidth === longSide && currentHeight === target) return `${fpsCap},setsar=1`;
      return `${fpsCap},scale=${longSide}:${target}:force_original_aspect_ratio=increase:flags=lanczos,crop=${longSide}:${target},setsar=1`;
    }
    if (currentWidth === target && currentHeight === target) return `${fpsCap},setsar=1`;
    return `${fpsCap},scale=${target}:${target}:flags=lanczos,setsar=1`;
  }

  function shopeeSafeCheck(width, height, targetHeight) {
    const target = Number.parseInt(targetHeight, 10) || 720;
    const longSide = Math.round(target * 16 / 9);
    const orientation = videoOrientation(width, height);
    let pass = false;
    let required = `${target} x ${longSide}`;

    if (orientation === "vertical") {
      pass = width >= target && height >= longSide;
      required = `${target} x ${longSide}`;
    } else if (orientation === "landscape") {
      pass = width >= longSide && height >= target;
      required = `${longSide} x ${target}`;
    } else {
      pass = width >= target && height >= target;
      required = `${target} x ${target}`;
    }

    return {
      pass,
      orientation,
      required,
      label: pass ? "Pass" : "Warning",
      note: pass ? "Shopee-safe resolution" : `Perlu minimum ${required}`
    };
  }

  async function readVideoMetadataFromUrl(url) {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
      };
      video.onloadedmetadata = () => {
        const metadata = {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          duration: Number.isFinite(video.duration) ? video.duration : 0
        };
        cleanup();
        resolve(metadata);
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("Gagal baca metadata output video."));
      };
      video.src = url;
    });
  }

  function renderVideoWarning() {
    const warning = document.getElementById("videoWarning");
    const messages = [];
    const bigCount = videoState.queue.filter((item) => item.size > VIDEO_SIZE_WARNING_BYTES).length;
    const longCount = videoState.queue.filter((item) => item.metadata.duration > VIDEO_DURATION_WARNING_SECONDS).length;
    const totalSize = videoState.queue.reduce((sum, item) => sum + item.size, 0);
    if (bigCount) {
      messages.push(`${bigCount} video lebih ${formatBytes(VIDEO_SIZE_WARNING_BYTES)}; conversion mungkin lambat terutama di phone.`);
    }
    if (longCount) {
      messages.push(`${longCount} video lebih ${formatVideoDuration(VIDEO_DURATION_WARNING_SECONDS)}; browser mungkin berat.`);
    }
    if (totalSize > VIDEO_SIZE_WARNING_BYTES) {
      messages.push(`Total queue ${formatBytes(totalSize)} akan duduk dalam browser memory sampai Reset Queue.`);
    }
    if (!messages.length) {
      warning.hidden = true;
      warning.innerHTML = "";
      return;
    }
    warning.hidden = false;
    warning.innerHTML = `<strong>Soft warning</strong><span>${htmlEscape(messages.join(" "))}</span>`;
  }

  function renderVideoMetadata() {
    const selected = selectedVideoItem();
    const totalSize = videoState.queue.reduce((sum, item) => sum + item.size, 0);
    const knownDuration = videoState.queue.reduce((sum, item) => sum + (item.metadata.duration || 0), 0);
    const allMetadataReady = videoState.queue.length && videoState.queue.every((item) => item.metadata.width || item.metadataError);
    document.getElementById("videoMetaName").textContent = videoState.queue.length ? `${videoState.queue.length} video` : "-";
    document.getElementById("videoMetaType").textContent = selected ? selected.type || "Unknown type" : "-";
    document.getElementById("videoMetaSize").textContent = videoState.queue.length ? formatBytes(totalSize) : "-";
    document.getElementById("videoMetaDuration").textContent = knownDuration ? formatVideoDuration(knownDuration) : "-";
    document.getElementById("videoMetaDurationNote").textContent = allMetadataReady ? "Total detected" : (videoState.queue.length ? "Reading metadata..." : "-");
    document.getElementById("videoMetaResolution").textContent = selected && selected.metadata.width ? `${selected.metadata.width} x ${selected.metadata.height}` : "-";
    document.getElementById("videoMetaRatio").textContent = selected ? aspectRatioText(selected.metadata.width, selected.metadata.height) : "-";
    renderVideoWarning();
  }

  function renderSelectedVideoPreview() {
    const preview = document.getElementById("inputVideoPreview");
    const selected = selectedVideoItem();
    if (!selected) {
      preview.removeAttribute("src");
      preview.hidden = true;
      preview.load();
      return;
    }
    preview.src = selected.previewUrl;
    preview.hidden = false;
  }

  function renderVideoQueue() {
    const list = document.getElementById("videoQueueList");
    document.getElementById("videoQueueCount").textContent = `${videoState.queue.length} video`;
    if (!videoState.queue.length) {
      list.innerHTML = `<div class="empty-state">Belum ada video dalam queue.</div>`;
      return;
    }
    list.innerHTML = videoState.queue.map((item, index) => {
      const metadataText = item.metadata.width ? `${item.metadata.width} x ${item.metadata.height}` : (item.metadataError ? "Metadata gagal" : "Reading metadata");
      const durationText = item.metadata.duration ? formatVideoDuration(item.metadata.duration) : "-";
      const outputText = item.outputMetadata.width ? `${item.outputMetadata.width} x ${item.outputMetadata.height}` : "-";
      const statusClass = item.status === "done" ? "profit" : item.status === "error" ? "loss" : item.status === "converting" ? "watch" : "muted";
      const safeLabel = item.safe ? item.safe.label : "-";
      const safeClass = item.safe && item.safe.pass ? "profit-text" : item.safe ? "watch-text" : "muted-text";
      const download = item.outputUrl
        ? `<a class="btn secondary queue-download" href="${htmlEscape(item.outputUrl)}" download="${htmlEscape(outputFileName(item, item.targetHeight || currentTargetHeight()))}">Download</a>`
        : `<span class="queue-download-placeholder">Download</span>`;
      return `
        <article class="video-queue-item ${videoState.selectedId === item.id ? "selected" : ""}" data-video-id="${htmlEscape(item.id)}">
          <button class="queue-select" type="button" data-select-video="${htmlEscape(item.id)}">
            <span class="queue-index">${index + 1}</span>
            <span class="queue-title">${htmlEscape(item.name)}</span>
            <span class="queue-status ${statusClass}">${htmlEscape(item.status)}</span>
          </button>
          <div class="queue-meta">
            <span>${htmlEscape(formatBytes(item.size))}</span>
            <span>${htmlEscape(durationText)}</span>
            <span>Input ${htmlEscape(metadataText)}</span>
            <span>Output ${htmlEscape(outputText)}</span>
            <span class="${safeClass}">Shopee ${htmlEscape(safeLabel)}</span>
            ${item.outputSize ? `<span>${htmlEscape(formatBytes(item.outputSize))}</span>` : ""}
            ${item.elapsedSeconds ? `<span>${htmlEscape(formatVideoDuration(item.elapsedSeconds))}</span>` : ""}
          </div>
          ${item.error ? `<div class="queue-error">${htmlEscape(item.error)}</div>` : ""}
          <div class="queue-actions">${download}</div>
        </article>
      `;
    }).join("");
  }

  function renderVideoFilePills() {
    const list = document.getElementById("videoFileName");
    if (!videoState.queue.length) {
      list.innerHTML = "";
      return;
    }
    const visible = videoState.queue.slice(0, 8).map((item) => `<span class="file-pill">${htmlEscape(item.name)}</span>`);
    if (videoState.queue.length > 8) {
      visible.push(`<span class="file-pill">+${videoState.queue.length - 8} lagi</span>`);
    }
    list.innerHTML = visible.join("");
  }

  function renderVideoWorkspace() {
    renderVideoFilePills();
    renderVideoMetadata();
    renderSelectedVideoPreview();
    renderVideoQueue();
    document.getElementById("videoFileInput").disabled = videoState.converting;
    document.getElementById("convertVideoBtn").disabled = !videoState.queue.length || videoState.converting;
    document.getElementById("resetVideoBtn").disabled = videoState.converting;
  }

  function resetVideoDom() {
    document.getElementById("videoFileInput").value = "";
    document.getElementById("videoWarning").hidden = true;
    document.getElementById("videoWarning").innerHTML = "";
    document.getElementById("videoLog").textContent = "Belum ada proses.";
    document.getElementById("convertVideoBtn").disabled = true;
    document.getElementById("resetVideoBtn").disabled = false;
    document.getElementById("videoOutputSummary").className = "upload-summary";
    document.getElementById("videoOutputSummary").innerHTML = "";
    setVideoProgress(0);
    setVideoStatus("muted", "Pilih video untuk mula.");
    renderVideoWorkspace();
  }

  async function resetVideoWorkspace() {
    if (videoState.converting) {
      setVideoStatus("watch", "Queue sedang convert. Tunggu siap sebelum reset.");
      return;
    }
    await deleteVirtualVideoFiles();
    videoState.queue.forEach((item) => {
      clearVideoItemOutput(item);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    videoState.queue = [];
    videoState.selectedId = "";
    videoState.converting = false;
    videoState.activeIndex = -1;
    resetVideoDom();
  }

  function updateOutputSummary(targetHeight, preset) {
    const summary = document.getElementById("videoOutputSummary");
    summary.className = "upload-summary active";
    const total = videoState.queue.length;
    const done = videoState.queue.filter((item) => item.status === "done").length;
    const errors = videoState.queue.filter((item) => item.status === "error").length;
    const pending = videoState.queue.filter((item) => item.status === "pending").length;
    const outputSize = videoState.queue.reduce((sum, item) => sum + (item.outputSize || 0), 0);
    const stats = [
      ["Queue", `${done}/${total} done`, errors ? `${errors} error, ${pending} pending` : `${pending} pending`],
      ["Output", "MP4", `${targetHeight}p untuk semua video`],
      ["Speed Mode", QUALITY_PRESETS[preset].label, `${QUALITY_PRESETS[preset].encoderPreset} | CRF ${QUALITY_PRESETS[preset].crf}`],
      ["Output Size", formatBytes(outputSize), done ? "Download dari list bawah" : "Belum ada output"]
    ];
    summary.innerHTML = stats.map(([label, value, note]) => (
      `<div class="upload-stat"><span>${htmlEscape(label)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small></div>`
    )).join("");
  }

  async function loadVideoFiles(files) {
    if (videoState.converting) {
      setVideoStatus("watch", "Queue sedang convert. Tunggu siap sebelum pilih video baru.");
      return;
    }
    await resetVideoWorkspace();
    const videoFiles = files.filter(looksLikeVideoFile);
    const rejected = files.length - videoFiles.length;
    videoState.queue = videoFiles.map((file, index) => ({
      id: videoItemId(index),
      file,
      name: file.name,
      type: file.type || "Unknown type",
      size: file.size,
      previewUrl: URL.createObjectURL(file),
      outputUrl: "",
      outputSize: 0,
      metadata: emptyVideoMetadata(),
      outputMetadata: emptyVideoMetadata(),
      metadataError: "",
      safe: null,
      status: "pending",
      error: "",
      targetHeight: "",
      preset: "",
      elapsedSeconds: 0
    }));
    videoState.selectedId = videoState.queue[0] ? videoState.queue[0].id : "";
    renderVideoWorkspace();
    if (!videoState.queue.length) {
      setVideoStatus("loss", rejected ? "Fail yang dipilih bukan video yang browser boleh baca." : "Pilih video untuk mula.");
      return;
    }
    document.getElementById("videoLog").textContent = rejected ? `${rejected} fail bukan video dibuang dari queue.` : "Video queue loaded. Sedia convert.";
    setVideoProgress(0);
    setVideoStatus("muted", `${videoState.queue.length} video dipilih. Pilih setting dan tekan Convert Queue.`);
    for (const item of videoState.queue) {
      try {
        item.metadata = await readVideoMetadataFromUrl(item.previewUrl);
      } catch (error) {
        item.metadataError = error.message || "Gagal baca metadata input.";
        appendVideoLog(`${item.name}: ${item.metadataError}`);
      }
      renderVideoWorkspace();
    }
  }

  async function ensureFfmpegEngine() {
    if (videoState.ffmpeg) return videoState;
    if (videoState.loadingEngine) return videoState.loadingEngine;

    videoState.loadingEngine = (async () => {
      try {
        setVideoProgress(0.05, "Loading FFmpeg engine untuk first-time use...");
        appendVideoLog(`Loading ffmpeg.wasm ${FFMPEG_VERSION} wrapper...`);
        await loadScriptOnce(FFMPEG_LOCAL_SCRIPT);
        const FFmpegClass = window.FFmpegWASM && window.FFmpegWASM.FFmpeg;
        if (!FFmpegClass) throw new Error("FFmpeg wrapper tidak tersedia.");
        appendVideoLog("Loading ffmpeg.wasm core...");
        const [coreURL, wasmURL] = await Promise.all([
          toBlobUrl(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
          toBlobUrl(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, "application/wasm")
        ]);
        const ffmpeg = new FFmpegClass();
        ffmpeg.on("log", ({ message }) => appendVideoLog(message));
        ffmpeg.on("progress", ({ progress }) => {
          if (videoState.converting) {
            const total = Math.max(videoState.queue.length, 1);
            const itemProgress = Math.max(0, Math.min(1, progress || 0));
            const overall = Math.min(0.98, Math.max(0.08, (Math.max(videoState.activeIndex, 0) + itemProgress) / total));
            setVideoProgress(overall, "Converting video...");
          }
        });
        await ffmpeg.load({
          coreURL,
          wasmURL
        });
        videoState.ffmpeg = ffmpeg;
        appendVideoLog("FFmpeg engine ready.");
        return videoState;
      } catch (error) {
        videoState.loadingEngine = null;
        throw new Error(`FFmpeg engine belum boleh dimuat. Semak internet untuk first-time load, kemudian cuba lagi. ${error.message || error}`);
      }
    })();
    return videoState.loadingEngine;
  }

  function currentTargetHeight() {
    const checked = document.querySelector("input[name='targetHeight']:checked");
    return checked ? checked.value : "720";
  }

  function currentQualityPreset() {
    const value = document.getElementById("qualityPreset").value;
    return QUALITY_PRESETS[value] ? value : "balanced";
  }

  function requiredVideoElementIds() {
    return [
      "videoFileInput",
      "videoQueueList",
      "videoQueueCount",
      "convertVideoBtn",
      "resetVideoBtn",
      "videoStatus",
      "videoLog",
      "videoOutputSummary",
      "inputVideoPreview"
    ];
  }

  function videoBootMessage(detail) {
    return `App update belum lengkap. Refresh/clear cache sekali. ${detail || ""}`.trim();
  }

  function showVideoBootIssue(detail) {
    const message = videoBootMessage(detail);
    const panel = document.getElementById("videoStatus");
    if (panel) {
      panel.className = "status-panel loss";
      const textNode = panel.querySelector("span");
      if (textNode) textNode.textContent = message;
      else panel.textContent = message;
    }
    const log = document.getElementById("videoLog");
    if (log) log.textContent = message;
    requiredVideoElementIds().forEach((id) => {
      const element = document.getElementById(id);
      if (element && "disabled" in element) element.disabled = true;
    });
    const queueList = document.getElementById("videoQueueList");
    if (queueList) queueList.innerHTML = `<div class="empty-state">${htmlEscape(message)}</div>`;
    const outputSummary = document.getElementById("videoOutputSummary");
    if (outputSummary) {
      outputSummary.className = "upload-summary active";
      outputSummary.innerHTML = `<div class="upload-stat"><span>Cache</span><strong>Refresh needed</strong><small>${htmlEscape(message)}</small></div>`;
    }
    return false;
  }

  function validateVideoConverterBoot() {
    const missing = requiredVideoElementIds().filter((id) => !document.getElementById(id));
    if (missing.length) {
      return showVideoBootIssue(`Missing UI: ${missing.join(", ")}.`);
    }
    const domBuild = document.body.dataset.appBuild || (document.querySelector("meta[name='app-build']") || {}).content || "";
    if (domBuild && domBuild !== APP_BUILD_VERSION) {
      return showVideoBootIssue(`HTML ${domBuild}, JS ${APP_BUILD_VERSION}.`);
    }
    if (SCRIPT_BUILD_VERSION && SCRIPT_BUILD_VERSION !== APP_BUILD_VERSION) {
      return showVideoBootIssue(`Script ${SCRIPT_BUILD_VERSION}, JS ${APP_BUILD_VERSION}.`);
    }
    return true;
  }

  async function convertQueueItem(item, index, targetHeight, preset) {
    const startedAt = performance.now();
    const quality = QUALITY_PRESETS[preset];
    const videoFilter = videoFilterForTarget(targetHeight, item.metadata);
    const inputName = `input-${index}.${safeFileExtension(item.file)}`;
    const outputName = `output-${index}-${targetHeight}p.mp4`;
    videoState.inputName = inputName;
    videoState.outputName = outputName;
    videoState.activeIndex = index;
    item.status = "converting";
    item.error = "";
    item.targetHeight = targetHeight;
    item.preset = preset;
    clearVideoItemOutput(item);
    renderVideoWorkspace();

    try {
      const engine = await ensureFfmpegEngine();
      appendVideoLog(`[${index + 1}/${videoState.queue.length}] Writing ${item.name} to memory...`);
      await engine.ffmpeg.writeFile(inputName, await readBlobAsBytes(item.file));
      const args = [
        "-i", inputName,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", videoFilter,
        "-threads", "0",
        "-c:v", "libx264",
        "-preset", quality.encoderPreset,
        "-crf", quality.crf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-sn",
        outputName
      ];
      appendVideoLog(`Command: ffmpeg ${args.join(" ")}`);
      const code = await engine.ffmpeg.exec(args);
      if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);
      const data = await engine.ffmpeg.readFile(outputName);
      const blob = new Blob([data], { type: "video/mp4" });
      item.outputSize = blob.size;
      item.outputUrl = URL.createObjectURL(blob);
      item.outputMetadata = await readVideoMetadataFromUrl(item.outputUrl);
      item.safe = shopeeSafeCheck(item.outputMetadata.width, item.outputMetadata.height, targetHeight);
      item.elapsedSeconds = (performance.now() - startedAt) / 1000;
      item.status = "done";
      appendVideoLog(`[${index + 1}/${videoState.queue.length}] ${item.name} siap dalam ${formatVideoDuration(item.elapsedSeconds)}.`);
    } catch (error) {
      clearVideoItemOutput(item);
      item.status = "error";
      item.error = error.message || "Conversion gagal.";
      appendVideoLog(`[${index + 1}/${videoState.queue.length}] Error ${item.name}: ${item.error}`);
    } finally {
      await deleteVirtualVideoFiles([inputName, outputName]);
      updateOutputSummary(targetHeight, preset);
      renderVideoWorkspace();
    }
  }

  async function convertVideoQueue() {
    if (!videoState.queue.length || videoState.converting) return;
    const targetHeight = currentTargetHeight();
    const preset = currentQualityPreset();
    videoState.converting = true;
    videoState.activeIndex = 0;
    document.getElementById("videoLog").textContent = "Preparing queue conversion...";
    clearQueueOutputs();
    updateOutputSummary(targetHeight, preset);
    renderVideoWorkspace();
    setVideoProgress(0.03, `Preparing ${videoState.queue.length} video...`);

    try {
      await ensureFfmpegEngine();
      for (let index = 0; index < videoState.queue.length; index += 1) {
        await convertQueueItem(videoState.queue[index], index, targetHeight, preset);
      }
      const done = videoState.queue.filter((item) => item.status === "done").length;
      const errors = videoState.queue.filter((item) => item.status === "error").length;
      setVideoProgress(1, "Queue conversion siap.");
      setVideoStatus(errors ? "watch" : "profit", errors ? `${done} video siap, ${errors} error. Download yang berjaya dari list.` : `${done} video siap. Download dari list.`);
    } catch (error) {
      appendVideoLog(`Error: ${error.message || error}`);
      setVideoStatus("loss", error.message || "Queue conversion gagal.");
      setVideoProgress(0);
    } finally {
      videoState.converting = false;
      videoState.activeIndex = -1;
      renderVideoWorkspace();
    }
  }

  function initVideoConverter() {
    if (!validateVideoConverterBoot()) return false;
    const input = document.getElementById("videoFileInput");
    const convertBtn = document.getElementById("convertVideoBtn");
    const resetBtn = document.getElementById("resetVideoBtn");
    const queueList = document.getElementById("videoQueueList");

    input.addEventListener("change", () => {
      const files = [...(input.files || [])];
      if (!files.length) {
        resetVideoWorkspace();
        return;
      }
      loadVideoFiles(files).catch((error) => {
        setVideoStatus("loss", error.message || "Gagal load video queue.");
        appendVideoLog(`Error: ${error.message || error}`);
      });
    });

    queueList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-select-video]");
      if (!button) return;
      videoState.selectedId = button.dataset.selectVideo;
      renderVideoWorkspace();
    });

    convertBtn.addEventListener("click", convertVideoQueue);
    resetBtn.addEventListener("click", () => resetVideoWorkspace());
    document.addEventListener("click", (event) => {
      const link = event.target.closest(".queue-download");
      if (!link) return;
      if (!link.getAttribute("href")) {
        event.preventDefault();
      }
    });
    return true;
  }

  function initDashboard() {
    let currentAnalysis = null;
    const fileInput = document.getElementById("fileInput");
    const analyzeBtn = document.getElementById("analyzeBtn");
    const saveBtn = document.getElementById("saveSnapshotBtn");
    const clearBtn = document.getElementById("clearBtn");
    const compareSelect = document.getElementById("snapshotCompare");
    const sidebarToggle = document.getElementById("sidebarToggle");
    const sidebarOpenBtn = document.getElementById("sidebarOpenBtn");
    const sidebarBackdrop = document.getElementById("sidebarBackdrop");

    document.querySelectorAll("[data-page-target]").forEach((button) => {
      button.addEventListener("click", () => setActivePage(button.dataset.pageTarget));
    });
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", () => {
        if (window.matchMedia("(max-width: 900px)").matches) {
          closeMobileSidebar();
          return;
        }
        setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
      });
    }
    if (sidebarOpenBtn) sidebarOpenBtn.addEventListener("click", openMobileSidebar);
    if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeMobileSidebar);
    setSidebarCollapsed(false);
    document.querySelectorAll('input[name="trendMode"]').forEach((input) => {
      input.addEventListener("change", () => renderTrend(currentAnalysis, currentTrendMode()));
    });
    const videoReady = initVideoConverter();
    renderSnapshots(null);
    clearCurrentAnalysisUi();
    if (videoReady) renderVideoWorkspace();

    fileInput.addEventListener("change", () => updateFileList(fileInput.files || []));

    analyzeBtn.addEventListener("click", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) {
        document.getElementById("statusPanel").className = "status-panel watch";
        document.getElementById("statusMessage").textContent = "Pilih sekurang-kurangnya satu CSV dahulu.";
        return;
      }
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "Menganalisis...";
      try {
        const payloads = await readFiles(files);
        currentAnalysis = analyzeUploads(payloads);
        renderAnalysis(currentAnalysis);
      } catch (error) {
        document.getElementById("statusPanel").className = "status-panel loss";
        document.getElementById("statusMessage").textContent = `Gagal analisis: ${error.message}`;
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Analisis";
      }
    });

    saveBtn.addEventListener("click", () => {
      if (!currentAnalysis) return;
      const name = document.getElementById("snapshotName").value.trim();
      const snapshots = loadSnapshots();
      snapshots.unshift(snapshotFromAnalysis(currentAnalysis, name));
      saveSnapshots(snapshots);
      document.getElementById("snapshotName").value = "";
      renderSnapshots(currentAnalysis);
    });

    compareSelect.addEventListener("change", () => renderCompare(currentAnalysis, compareSelect.value));

    clearBtn.addEventListener("click", () => {
      currentAnalysis = null;
      fileInput.value = "";
      updateFileList([]);
      clearCurrentAnalysisUi();
      renderSnapshots(null);
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    }
  }

  const core = {
    CORE_VERSION,
    APP_BUILD_VERSION,
    parseCsv,
    detectFile,
    analyzeUploads,
    parseNumber,
    normalizeSubId4,
    normalizeAdNo
  };

  if (typeof window !== "undefined") {
    window.ShopeeDashboardCore = core;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = core;
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  }
}());
